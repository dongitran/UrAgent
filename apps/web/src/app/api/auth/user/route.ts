import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken } from "@/lib/auth";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";
import {
  getKeycloakAccessToken,
  getKeycloakRefreshToken,
  getKeycloakUserInfo,
  decodeKeycloakToken,
  isKeycloakEnabled,
  refreshAccessToken,
  KEYCLOAK_ACCESS_TOKEN_COOKIE,
  KEYCLOAK_REFRESH_TOKEN_COOKIE,
  KEYCLOAK_ID_TOKEN_COOKIE,
} from "@/lib/keycloak";

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

/**
 * Try to refresh Keycloak token if it's expired
 */
async function tryRefreshKeycloakToken(
  req: NextRequest,
): Promise<string | null> {
  const refreshToken = getKeycloakRefreshToken(req);
  if (!refreshToken) {
    return null;
  }

  try {
    const tokenData = await refreshAccessToken(refreshToken);
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
function hasDefaultConfig(): { hasConfig: boolean; installationName?: string } {
  // If Keycloak is enabled, don't use default config
  if (isKeycloakEnabled()) {
    return { hasConfig: false };
  }

  const defaultInstallationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
  const defaultInstallationName = process.env.DEFAULT_GITHUB_INSTALLATION_NAME;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  const hasConfig = !!(
    defaultInstallationId &&
    defaultInstallationName &&
    appId &&
    privateKey
  );
  return { hasConfig, installationName: defaultInstallationName };
}

export async function GET(request: NextRequest) {
  try {
    // If Keycloak is enabled, it's the ONLY auth method
    if (isKeycloakEnabled()) {
      // First check for refreshed token from middleware (via header)
      // Then fall back to cookie
      let keycloakToken = getAccessToken(request);

      // If no token or token is expired, try to refresh
      if (!keycloakToken || isTokenExpiredOrExpiring(keycloakToken)) {
        const refreshedToken = await tryRefreshKeycloakToken(request);
        if (refreshedToken) {
          keycloakToken = refreshedToken;
        }
      }

      if (!keycloakToken) {
        const response = NextResponse.json(
          { error: "Not authenticated" },
          { status: 401 },
        );
        // Clear expired cookies to prevent redirect loop
        response.cookies.delete(KEYCLOAK_ACCESS_TOKEN_COOKIE);
        response.cookies.delete(KEYCLOAK_REFRESH_TOKEN_COOKIE);
        response.cookies.delete(KEYCLOAK_ID_TOKEN_COOKIE);
        return response;
      }

      // Try to get user info from Keycloak
      const userInfo = await getKeycloakUserInfo(keycloakToken);

      if (userInfo) {
        return NextResponse.json({
          user: {
            id: userInfo.sub,
            login: userInfo.preferred_username,
            name: userInfo.name || userInfo.preferred_username,
            email: userInfo.email,
            avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(userInfo.preferred_username)}&background=random`,
          },
          authProvider: "keycloak",
        });
      }

      // Fallback: decode token directly
      const decoded = decodeKeycloakToken(keycloakToken);
      if (decoded) {
        return NextResponse.json({
          user: {
            id: decoded.sub,
            login: decoded.preferred_username,
            name: decoded.name || decoded.preferred_username,
            email: decoded.email,
            avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(decoded.preferred_username)}&background=random`,
          },
          authProvider: "keycloak",
        });
      }

      const invalidTokenResponse = NextResponse.json({ error: "Invalid token" }, { status: 401 });
      // Clear invalid cookies to prevent redirect loop
      invalidTokenResponse.cookies.delete(KEYCLOAK_ACCESS_TOKEN_COOKIE);
      invalidTokenResponse.cookies.delete(KEYCLOAK_REFRESH_TOKEN_COOKIE);
      invalidTokenResponse.cookies.delete(KEYCLOAK_ID_TOKEN_COOKIE);
      return invalidTokenResponse;
    }

    // Keycloak NOT enabled - check GitHub OAuth
    const token = getGitHubToken(request);

    if (token && token.access_token) {
      const user = await verifyGithubUser(token.access_token);
      if (user) {
        return NextResponse.json({
          user: {
            login: user.login,
            avatar_url: user.avatar_url,
            html_url: user.html_url,
            name: user.name,
            email: user.email,
          },
          authProvider: "github",
        });
      }
    }

    // Fall back to default config if available
    const { hasConfig, installationName } = hasDefaultConfig();
    if (hasConfig && installationName) {
      return NextResponse.json({
        user: {
          login: installationName,
          avatar_url: `https://github.com/${installationName}.png`,
          html_url: `https://github.com/${installationName}`,
          name: installationName,
          email: null,
        },
        isDefaultConfig: true,
        authProvider: "default",
      });
    }

    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  } catch (error) {
    console.error("Error in /api/auth/user:", error);
    return NextResponse.json(
      { error: "Failed to fetch user info" },
      { status: 500 },
    );
  }
}
