import { NextRequest, NextResponse } from "next/server";
import { clearGitHubToken } from "@/lib/auth";
import {
  clearKeycloakTokens,
  isKeycloakEnabled,
  buildKeycloakLogoutUrl,
  KEYCLOAK_ID_TOKEN_COOKIE,
} from "@/lib/keycloak";

/**
 * API route to handle logout (supports both GitHub and Keycloak)
 */
export async function POST(request: NextRequest) {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Check if Keycloak is enabled and user has Keycloak token
    if (isKeycloakEnabled()) {
      const idToken = request.cookies.get(KEYCLOAK_ID_TOKEN_COOKIE)?.value;

      // If user has Keycloak token, redirect to Keycloak logout
      if (idToken) {
        const logoutUrl = buildKeycloakLogoutUrl(idToken);
        const response = NextResponse.json({
          success: true,
          redirectUrl: logoutUrl,
          provider: "keycloak",
        });
        clearKeycloakTokens(response);
        clearGitHubToken(response);
        return response;
      }
    }

    // Default: clear GitHub tokens
    const response = NextResponse.json({
      success: true,
      redirectUrl: appUrl,
      provider: "github",
    });
    clearGitHubToken(response);
    clearKeycloakTokens(response);
    return response;
  } catch (error) {
    console.error("Error during logout:", error);
    return NextResponse.json(
      { success: false, error: "Failed to logout" },
      { status: 500 },
    );
  }
}

/**
 * GET handler for direct logout (redirect flow)
 */
export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Check if Keycloak is enabled
  if (isKeycloakEnabled()) {
    const idToken = request.cookies.get(KEYCLOAK_ID_TOKEN_COOKIE)?.value;

    if (idToken) {
      const logoutUrl = buildKeycloakLogoutUrl(idToken);
      const response = NextResponse.redirect(logoutUrl);
      clearKeycloakTokens(response);
      clearGitHubToken(response);
      return response;
    }
  }

  // Default: redirect to home
  const response = NextResponse.redirect(appUrl);
  clearGitHubToken(response);
  clearKeycloakTokens(response);
  return response;
}
