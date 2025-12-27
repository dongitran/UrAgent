import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  storeKeycloakTokens,
  isKeycloakEnabled,
  KEYCLOAK_STATE_COOKIE,
} from "@/lib/keycloak";
import { GITHUB_INSTALLATION_ID_COOKIE } from "@openswe/shared/constants";
import { getInstallationCookieOptions } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!isKeycloakEnabled()) {
    return NextResponse.json(
      { error: "Keycloak authentication is not configured" },
      { status: 500 },
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  // Handle error from Keycloak
  if (error) {
    console.error("Keycloak auth error:", error, errorDescription);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    return NextResponse.redirect(
      `${appUrl}/?error=${encodeURIComponent(error)}`,
    );
  }

  // Verify state
  const storedState = request.cookies.get(KEYCLOAK_STATE_COOKIE)?.value;
  if (!state || state !== storedState) {
    console.error("State mismatch:", { state, storedState });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    return NextResponse.redirect(`${appUrl}/?error=invalid_state`);
  }

  if (!code) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    return NextResponse.redirect(`${appUrl}/?error=no_code`);
  }

  try {
    // Exchange code for tokens
    const tokenData = await exchangeCodeForTokens(code);

    // Redirect to chat page
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const response = NextResponse.redirect(`${appUrl}/chat`);

    // Store tokens in cookies
    storeKeycloakTokens(tokenData, response);

    // Clear state cookie
    response.cookies.delete(KEYCLOAK_STATE_COOKIE);

    // Set default GitHub installation ID if configured
    const defaultInstallationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
    if (defaultInstallationId) {
      response.cookies.set(
        GITHUB_INSTALLATION_ID_COOKIE,
        defaultInstallationId,
        getInstallationCookieOptions(),
      );
    }

    return response;
  } catch (error) {
    console.error("Failed to exchange code for tokens:", error);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    return NextResponse.redirect(`${appUrl}/?error=token_exchange_failed`);
  }
}
