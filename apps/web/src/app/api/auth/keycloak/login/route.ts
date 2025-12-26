import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  buildKeycloakAuthUrl,
  isKeycloakEnabled,
  KEYCLOAK_STATE_COOKIE,
} from "@/lib/keycloak";

export async function GET() {
  if (!isKeycloakEnabled()) {
    return NextResponse.json(
      { error: "Keycloak authentication is not configured" },
      { status: 500 },
    );
  }

  // Generate state for CSRF protection
  const state = uuidv4();
  
  // Build authorization URL
  const authUrl = buildKeycloakAuthUrl(state);
  
  // Create redirect response
  const response = NextResponse.redirect(authUrl);
  
  // Store state in cookie for verification
  // Use SameSite=None for cross-domain OAuth redirects
  response.cookies.set(KEYCLOAK_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 60 * 10, // 10 minutes
    path: "/",
  });

  return response;
}
