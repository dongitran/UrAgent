import { NextRequest, NextResponse } from "next/server";
import {
  getKeycloakAccessToken,
  getKeycloakUserInfo,
  decodeKeycloakToken,
  isKeycloakEnabled,
} from "@/lib/keycloak";

export async function GET(request: NextRequest) {
  if (!isKeycloakEnabled()) {
    return NextResponse.json(
      { error: "Keycloak authentication is not configured" },
      { status: 500 },
    );
  }

  const accessToken = getKeycloakAccessToken(request);

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
