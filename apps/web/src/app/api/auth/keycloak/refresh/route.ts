import { NextRequest, NextResponse } from "next/server";
import {
  getKeycloakRefreshToken,
  refreshAccessToken,
  storeKeycloakTokens,
  isKeycloakEnabled,
} from "@/lib/keycloak";

export async function POST(request: NextRequest) {
  if (!isKeycloakEnabled()) {
    return NextResponse.json(
      { error: "Keycloak authentication is not configured" },
      { status: 500 },
    );
  }

  const refreshToken = getKeycloakRefreshToken(request);

  if (!refreshToken) {
    return NextResponse.json(
      { error: "No refresh token available" },
      { status: 401 },
    );
  }

  try {
    const tokenData = await refreshAccessToken(refreshToken);

    const response = NextResponse.json({ success: true });
    storeKeycloakTokens(tokenData, response);

    return response;
  } catch (error) {
    console.error("Failed to refresh token:", error);
    return NextResponse.json(
      { error: "Failed to refresh token" },
      { status: 401 },
    );
  }
}
