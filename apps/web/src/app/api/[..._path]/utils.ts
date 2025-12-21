import { getInstallationToken } from "@openswe/shared/github/auth";
import { App } from "@octokit/app";
import { GITHUB_TOKEN_COOKIE } from "@openswe/shared/constants";
import { encryptSecret } from "@openswe/shared/crypto";
import { NextRequest } from "next/server";
import {
  getKeycloakAccessToken,
  verifyKeycloakToken,
  isKeycloakEnabled,
  decodeKeycloakToken,
} from "@/lib/keycloak";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";

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

  return !!(defaultInstallationId && defaultInstallationName && appId && privateKey);
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
    const keycloakToken = getKeycloakAccessToken(req);
    
    if (!keycloakToken) {
      return {
        authenticated: false,
        error: "Keycloak authentication required",
      };
    }

    // Decode the token to get user info
    const decoded = decodeKeycloakToken(keycloakToken);
    
    if (decoded) {
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
  const app = new App({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  });

  // Get installation details
  const { data } = await app.octokit.request(
    "GET /app/installations/{installation_id}",
    {
      installation_id: Number(installationId),
    },
  );

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
