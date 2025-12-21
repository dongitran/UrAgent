import { NextRequest, NextResponse } from "next/server";
import {
  getKeycloakAccessToken,
  getKeycloakRefreshToken,
  getKeycloakUserInfo,
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
async function tryRefreshKeycloakToken(req: NextRequest): Promise<string | null> {
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

export async function GET(request: NextRequest) {
  if (!isKeycloakEnabled()) {
    return NextResponse.json(
      { error: "Keycloak authentication is not configured" },
      { status: 500 },
    );
  }

  // First check for refreshed token from middleware (via header)
  // Then fall back to cookie
  let accessToken = getAccessToken(request);

  // If no token or token is expired, try to refresh
  if (!accessToken || isTokenExpiredOrExpiring(accessToken)) {
    const refreshedToken = await tryRefreshKeycloakToken(request);
    if (refreshedToken) {
      accessToken = refreshedToken;
    }
  }

  if (!accessToken) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 },
    );
  }

  try {
    // Try to get user info from Keycloak userinfo endpoint
    const userInfo = await getKeycloakUserInfo(accessToken);

    if (userInfo) {
      return NextResponse.json({
        user: {
          id: userInfo.sub,
          login: userInfo.preferred_username,
          name: userInfo.name || userInfo.preferred_username,
          email: userInfo.email,
          // Generate avatar URL based on username
          avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(userInfo.preferred_username)}&background=random`,
        },
        authProvider: "keycloak",
      });
    }

    // Fallback: decode token directly
    const decoded = decodeKeycloakToken(accessToken);
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

    return NextResponse.json(
      { error: "Failed to get user info" },
      { status: 401 },
    );
  } catch (error) {
    console.error("Error getting Keycloak user info:", error);
    return NextResponse.json(
      { error: "Failed to get user info" },
      { status: 500 },
    );
  }
}
