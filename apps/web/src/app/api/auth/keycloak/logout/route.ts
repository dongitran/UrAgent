import { NextRequest, NextResponse } from "next/server";
import {
  clearKeycloakTokens,
  buildKeycloakLogoutUrl,
  isKeycloakEnabled,
  KEYCLOAK_ID_TOKEN_COOKIE,
} from "@/lib/keycloak";

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (!isKeycloakEnabled()) {
    // If Keycloak is not enabled, just clear cookies and redirect
    const response = NextResponse.redirect(appUrl);
    clearKeycloakTokens(response);
    return response;
  }

  // Get ID token for logout hint
  const idToken = request.cookies.get(KEYCLOAK_ID_TOKEN_COOKIE)?.value;

  // Build Keycloak logout URL
  const logoutUrl = buildKeycloakLogoutUrl(idToken);

  // Create response that redirects to Keycloak logout
  const response = NextResponse.redirect(logoutUrl);

  // Clear all Keycloak tokens
  clearKeycloakTokens(response);

  return response;
}

export async function POST(request: NextRequest) {
  // Also support POST for programmatic logout
  return GET(request);
}
