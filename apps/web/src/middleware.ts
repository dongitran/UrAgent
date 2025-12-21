import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
} from "@openswe/shared/constants";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";
import { KEYCLOAK_ACCESS_TOKEN_COOKIE } from "@/lib/keycloak";

/**
 * Check if default GitHub configuration is available
 * This allows bypassing OAuth flow when env vars are configured
 */
function hasDefaultConfig(): boolean {
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
 * Check if user has valid Keycloak token
 */
function hasKeycloakToken(request: NextRequest): boolean {
  const token = request.cookies.get(KEYCLOAK_ACCESS_TOKEN_COOKIE)?.value;
  return !!token;
}

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(GITHUB_TOKEN_COOKIE)?.value;
  const installationId = request.cookies.get(
    GITHUB_INSTALLATION_ID_COOKIE,
  )?.value;
  const user = token && installationId ? await verifyGithubUser(token) : null;

  // Check if we have default config (bypass OAuth)
  const useDefaultConfig = hasDefaultConfig();
  
  // Check if Keycloak is enabled and user has valid token
  const keycloakEnabled = isKeycloakEnabled();
  const hasValidKeycloakToken = keycloakEnabled && hasKeycloakToken(request);

  // User is authenticated if:
  // 1. Has valid GitHub OAuth token, OR
  // 2. Has valid Keycloak token (when Keycloak is enabled), OR
  // 3. Default config is available (development mode)
  const isAuthenticated = !!user || hasValidKeycloakToken || useDefaultConfig;

  if (request.nextUrl.pathname === "/") {
    // If user is authenticated, redirect to chat
    if (isAuthenticated) {
      const url = request.nextUrl.clone();
      url.pathname = "/chat";
      return NextResponse.redirect(url);
    }
    
    // If Keycloak is enabled but user not authenticated, redirect to Keycloak login
    if (keycloakEnabled && !hasValidKeycloakToken) {
      const url = request.nextUrl.clone();
      url.pathname = "/api/auth/keycloak/login";
      return NextResponse.redirect(url);
    }
  }

  if (request.nextUrl.pathname.startsWith("/chat")) {
    // Allow access if user is authenticated
    if (!isAuthenticated) {
      const url = request.nextUrl.clone();
      
      // If Keycloak is enabled, redirect to Keycloak login
      if (keycloakEnabled) {
        url.pathname = "/api/auth/keycloak/login";
      } else {
        url.pathname = "/";
      }
      
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/chat/:path*"],
};
