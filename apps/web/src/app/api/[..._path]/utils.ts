import { getInstallationToken } from "@openswe/shared/github/auth";
import { GITHUB_TOKEN_COOKIE } from "@openswe/shared/constants";
import { encryptSecret } from "@openswe/shared/crypto";
import { NextRequest } from "next/server";
import {
  getKeycloakAccessToken,
  getKeycloakRefreshToken,
  verifyKeycloakToken,
  isKeycloakEnabled,
  decodeKeycloakToken,
  refreshAccessToken,
} from "@/lib/keycloak";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";
import { fetchWithRetry } from "@openswe/shared/utils/fetch-with-retry";

// Header name for refreshed token from middleware
const REFRESHED_TOKEN_HEADER = "x-keycloak-refreshed-token";

/**
 * Get Keycloak access token from request
 * First checks for refreshed token from middleware, then falls back to cookie
 */
function getAccessToken(req: NextRequest): string | null {
  // Check if middleware already refreshed the token
  const refreshedToken = req.headers.get(REFRESHED_TOKEN_HEADER);
  if (refreshedToken) {
    return refreshedToken;
  }

  // Fall back to cookie
  return getKeycloakAccessToken(req);
}

/**
 * Check if Keycloak token is expired or about to expire (within 30 seconds)
 */
function isTokenExpiredOrExpiring(token: string): boolean {
  try {
    const decoded = decodeKeycloakToken(token) as any;
    if (!decoded || !decoded.exp) {
      return true;
    }
    // Check if token expires within 30 seconds
    const expiresAt = decoded.exp * 1000;
    const now = Date.now();
    return expiresAt - now < 30000; // 30 seconds buffer
  } catch {
    return true;
  }
}

// Cache for refreshed tokens to avoid multiple refresh calls
const tokenRefreshCache = new Map<
  string,
  { token: string; expiresAt: number }
>();

/**
 * Try to refresh Keycloak token if it's expired
 * Returns the new access token or null if refresh failed
 */
async function tryRefreshKeycloakToken(
  req: NextRequest,
): Promise<string | null> {
  const refreshToken = getKeycloakRefreshToken(req);
  if (!refreshToken) {
    return null;
  }

  // Check cache first (use refresh token as key)
  const cacheKey = refreshToken.substring(0, 32); // Use first 32 chars as key
  const cached = tokenRefreshCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const tokenData = await refreshAccessToken(refreshToken);

    // Cache the new token
    const decoded = decodeKeycloakToken(tokenData.access_token) as any;
    const expiresAt = decoded?.exp ? decoded.exp * 1000 : Date.now() + 300000; // 5 min default
    tokenRefreshCache.set(cacheKey, {
      token: tokenData.access_token,
      expiresAt: expiresAt - 30000, // 30 seconds buffer
    });

    // Clean up old cache entries
    if (tokenRefreshCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of tokenRefreshCache.entries()) {
        if (value.expiresAt < now) {
          tokenRefreshCache.delete(key);
        }
      }
    }

    return tokenData.access_token;
  } catch (error) {
    console.error("Failed to refresh Keycloak token:", error);
    return null;
  }
}

/**
 * Check if default GitHub configuration is available
 * NOTE: Default config is disabled when Keycloak is enabled
 */
function hasDefaultConfig(): boolean {
  // If Keycloak is enabled, don't use default config (require Keycloak login)
  if (isKeycloakEnabled()) {
    return false;
  }

  const defaultInstallationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
  const defaultInstallationName = process.env.DEFAULT_GITHUB_INSTALLATION_NAME;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  return !!(
    defaultInstallationId &&
    defaultInstallationName &&
    appId &&
    privateKey
  );
}

export interface AuthResult {
  authenticated: boolean;
  user?: {
    id?: string;
    login: string;
    email?: string;
  };
  provider?: "keycloak" | "github" | "default";
  error?: string;
}

/**
 * Verify request authentication
 * When Keycloak is enabled, ONLY Keycloak token is accepted
 * Otherwise, checks GitHub token or default config
 */
export async function verifyRequestAuth(req: NextRequest): Promise<AuthResult> {
  // If Keycloak is enabled, it's the ONLY auth method
  if (isKeycloakEnabled()) {
    // First check for refreshed token from middleware (via header)
    // Then fall back to cookie
    let keycloakToken = getAccessToken(req);

    // If no token or token is expired, try to refresh
    if (!keycloakToken || isTokenExpiredOrExpiring(keycloakToken)) {
      const refreshedToken = await tryRefreshKeycloakToken(req);
      if (refreshedToken) {
        keycloakToken = refreshedToken;
      }
    }

    if (!keycloakToken) {
      return {
        authenticated: false,
        error: "Keycloak authentication required",
      };
    }

    // Decode the token to get user info
    const decoded = decodeKeycloakToken(keycloakToken);

    if (decoded) {
      // Check if token is still valid (not expired)
      const tokenData = decoded as any;
      if (tokenData.exp && tokenData.exp * 1000 < Date.now()) {
        return {
          authenticated: false,
          error: "Keycloak token expired",
        };
      }

      return {
        authenticated: true,
        user: {
          id: decoded.sub,
          login: decoded.preferred_username,
          email: decoded.email,
        },
        provider: "keycloak",
      };
    }

    // If decode fails, try verification
    const isValid = await verifyKeycloakToken(keycloakToken);
    if (isValid) {
      return {
        authenticated: true,
        provider: "keycloak",
      };
    }

    return {
      authenticated: false,
      error: "Invalid Keycloak token",
    };
  }

  // Keycloak NOT enabled - check GitHub OAuth or default config
  const githubToken = req.cookies.get(GITHUB_TOKEN_COOKIE)?.value;
  if (githubToken) {
    try {
      const user = await verifyGithubUser(githubToken);
      if (user) {
        return {
          authenticated: true,
          user: {
            id: user.id?.toString(),
            login: user.login,
            email: user.email || undefined,
          },
          provider: "github",
        };
      }
    } catch {
      // GitHub token invalid, continue to check default config
    }
  }

  // Check default config (development mode)
  if (hasDefaultConfig()) {
    const installationName = process.env.DEFAULT_GITHUB_INSTALLATION_NAME;
    return {
      authenticated: true,
      user: {
        login: installationName || "default",
      },
      provider: "default",
    };
  }

  return {
    authenticated: false,
    error: "No valid authentication found",
  };
}

export function getGitHubAccessTokenOrThrow(
  req: NextRequest,
  encryptionKey: string,
): string {
  const token = req.cookies.get(GITHUB_TOKEN_COOKIE)?.value ?? "";

  // If no OAuth token, return empty string (will use installation token instead)
  // This allows default config mode to work without OAuth login
  if (!token) {
    return "";
  }

  return encryptSecret(token, encryptionKey);
}

export async function getGitHubInstallationTokenOrThrow(
  installationIdCookie: string,
  encryptionKey: string,
): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateAppKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateAppKey) {
    throw new Error("GitHub App ID or Private App Key is not configured.");
  }

  const token = await getInstallationToken(
    installationIdCookie,
    appId,
    privateAppKey,
  );
  return encryptSecret(token, encryptionKey);
}

async function getInstallationName(installationId: string) {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App ID or Private App Key is not configured.");
  }

  // Use fetchWithRetry for the GitHub API call
  const { generateJWT } = await import("@openswe/shared/jwt");
  const jwtToken = generateJWT(
    process.env.GITHUB_APP_ID,
    process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  );

  const response = await fetchWithRetry(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "OpenSWE-Agent",
      },
    },
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      timeoutMs: 30000,
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      `Failed to get installation: ${JSON.stringify(errorData)}`,
    );
  }

  const data = await response.json();
  const installationName =
    data.account && "name" in data.account
      ? data.account.name
      : data.account?.login;

  return installationName ?? "";
}

export async function getInstallationNameFromReq(
  req: Request,
  installationId: string,
): Promise<string> {
  try {
    const reqCopy = req.clone();
    const requestJson = await reqCopy.json();
    const installationName = requestJson?.input?.targetRepository?.owner;
    if (installationName) {
      return installationName;
    }
  } catch {
    // no-op
  }

  try {
    return await getInstallationName(installationId);
  } catch (error) {
    console.error("Failed to get installation name:", error);
    return "";
  }
}
