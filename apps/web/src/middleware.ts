import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
} from "@openswe/shared/constants";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";
import { KEYCLOAK_ACCESS_TOKEN_COOKIE, KEYCLOAK_REFRESH_TOKEN_COOKIE, decodeKeycloakToken } from "@/lib/keycloak";

/**
 * Check if default GitHub configuration is available
 * This allows bypassing OAuth flow when env vars are configured
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

/**
 * Check if Keycloak is enabled
 */
function isKeycloakEnabled(): boolean {
  const keycloakUrl = process.env.NEXT_PUBLIC_KEYCLOAK_URL;
  const keycloakRealm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM;
  const keycloakClientId = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID;
  
  return !!(keycloakUrl && keycloakRealm && keycloakClientId);
}

/**
 * Check if user has valid (non-expired) Keycloak token
 * Also checks if refresh token is available for auto-refresh
 */
function hasValidKeycloakAuth(request: NextRequest): boolean {
  const accessToken = request.cookies.get(KEYCLOAK_ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(KEYCLOAK_REFRESH_TOKEN_COOKIE)?.value;
  
  // If no tokens at all, not authenticated
  if (!accessToken && !refreshToken) {
    return false;
  }
  
  // If we have a refresh token, we can refresh the access token in API routes
  // So consider it as "authenticated" for middleware purposes
  if (refreshToken) {
    return true;
  }
  
  // If only access token (no refresh), check if it's expired
  if (accessToken) {
    try {
      const decoded = decodeKeycloakToken(accessToken) as any;
      if (decoded && decoded.exp) {
        // Token is valid if not expired
        return decoded.exp * 1000 > Date.now();
      }
      // If no exp claim, assume valid
      return true;
    } catch {
      return false;
    }
  }
  
  return false;
}

export async function middleware(request: NextRequest) {
  // Check if Keycloak is enabled - if so, it's the ONLY auth method
  const keycloakEnabled = isKeycloakEnabled();
  
  if (keycloakEnabled) {
    // Keycloak is enabled - ONLY accept Keycloak token
    const hasValidAuth = hasValidKeycloakAuth(request);

    if (request.nextUrl.pathname === "/") {
      if (hasValidAuth) {
        const url = request.nextUrl.clone();
        url.pathname = "/chat";
        return NextResponse.redirect(url);
      }
      // Redirect to Keycloak login
      const url = request.nextUrl.clone();
      url.pathname = "/api/auth/keycloak/login";
      return NextResponse.redirect(url);
    }

    if (request.nextUrl.pathname.startsWith("/chat")) {
      if (!hasValidAuth) {
        const url = request.nextUrl.clone();
        url.pathname = "/api/auth/keycloak/login";
        return NextResponse.redirect(url);
      }
    }

    return NextResponse.next();
  }

  // Keycloak NOT enabled - use GitHub OAuth or default config
  const token = request.cookies.get(GITHUB_TOKEN_COOKIE)?.value;
  const installationId = request.cookies.get(
    GITHUB_INSTALLATION_ID_COOKIE,
  )?.value;
  const user = token && installationId ? await verifyGithubUser(token) : null;
  const useDefaultConfig = hasDefaultConfig();

  const isAuthenticated = !!user || useDefaultConfig;

  if (request.nextUrl.pathname === "/") {
    if (isAuthenticated) {
      const url = request.nextUrl.clone();
      url.pathname = "/chat";
      return NextResponse.redirect(url);
    }
  }

  if (request.nextUrl.pathname.startsWith("/chat")) {
    if (!isAuthenticated) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/chat/:path*"],
};
