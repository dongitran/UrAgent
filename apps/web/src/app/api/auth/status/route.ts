import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  getKeycloakAccessToken,
  getKeycloakRefreshToken,
  decodeKeycloakToken,
  isKeycloakEnabled,
  refreshAccessToken,
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
    const expiresAt = decoded.exp * 1000;
    const now = Date.now();
    return expiresAt - now < 30000;
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
function hasDefaultConfig(): boolean {
  // If Keycloak is enabled, don't use default config
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

/**
 * API route to check authentication status (supports both GitHub and Keycloak)
 */
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
        return NextResponse.json({
          authenticated: false,
          provider: "keycloak",
        });
      }

      // Decode token to check if valid
      const decoded = decodeKeycloakToken(keycloakToken);
      if (decoded) {
        // Check if token is still valid (not expired)
        const tokenData = decoded as any;
        if (tokenData.exp && tokenData.exp * 1000 < Date.now()) {
          return NextResponse.json({
            authenticated: false,
            provider: "keycloak",
            reason: "token_expired",
          });
        }

        return NextResponse.json({
          authenticated: true,
          provider: "keycloak",
        });
      }

      return NextResponse.json({
        authenticated: false,
        provider: "keycloak",
        reason: "invalid_token",
      });
    }

    // Keycloak NOT enabled - check GitHub OAuth
    const githubAuthenticated = isAuthenticated(request);
    if (githubAuthenticated) {
      return NextResponse.json({
        authenticated: true,
        provider: "github",
      });
    }

    // Check default config
    if (hasDefaultConfig()) {
      return NextResponse.json({
        authenticated: true,
        provider: "default",
      });
    }

    return NextResponse.json({
      authenticated: false,
    });
  } catch (error) {
    console.error("Error checking auth status:", error);
    return NextResponse.json(
      { authenticated: false, error: "Failed to check authentication status" },
      { status: 500 },
    );
  }
}
