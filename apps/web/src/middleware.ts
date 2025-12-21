import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
} from "@openswe/shared/constants";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";
import { 
  KEYCLOAK_ACCESS_TOKEN_COOKIE, 
  KEYCLOAK_REFRESH_TOKEN_COOKIE, 
  KEYCLOAK_ID_TOKEN_COOKIE,
} from "@/lib/keycloak";

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
 * Decode JWT token without verification (for Edge Runtime)
 * Only decodes the payload, does not verify signature
 */
function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Check if access token is expired or about to expire (within 30 seconds)
 */
function isTokenExpiredOrExpiring(token: string): boolean {
  try {
    const decoded = decodeJwtPayload(token);
    if (!decoded || !decoded.exp) {
      return true;
    }
    const expiresAt = decoded.exp * 1000;
    const now = Date.now();
    return expiresAt - now < 30000; // 30 seconds buffer
  } catch {
    return true;
  }
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
      const decoded = decodeJwtPayload(accessToken);
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

/**
 * Refresh Keycloak token (Edge Runtime compatible)
 */
async function refreshKeycloakToken(refreshToken: string): Promise<any> {
  const keycloakUrl = process.env.NEXT_PUBLIC_KEYCLOAK_URL;
  const keycloakRealm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM;
  const keycloakClientId = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID;
  const keycloakClientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  
  const tokenUrl = `${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/token`;
  
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: keycloakClientId || "",
    refresh_token: refreshToken,
  });

  if (keycloakClientSecret) {
    params.append("client_secret", keycloakClientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh token");
  }

  return response.json();
}

/**
 * Cookie options for Keycloak tokens
 */
function getCookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: maxAge || 60 * 60 * 24, // Default 24 hours
    path: "/",
  };
}

/**
 * Try to refresh token and return response with new cookies
 * Returns null if refresh fails
 */
async function tryRefreshAndSetCookies(request: NextRequest): Promise<NextResponse | null> {
  const refreshToken = request.cookies.get(KEYCLOAK_REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return null;
  }

  try {
    const tokenData = await refreshKeycloakToken(refreshToken);
    
    // Clone the request headers and add the refreshed token
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-keycloak-refreshed-token", tokenData.access_token);
    
    // Create response that continues with modified request headers
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    
    // Set new access token in cookie for future requests
    response.cookies.set(
      KEYCLOAK_ACCESS_TOKEN_COOKIE,
      tokenData.access_token,
      getCookieOptions(tokenData.expires_in),
    );

    // Set new refresh token if provided
    if (tokenData.refresh_token) {
      response.cookies.set(
        KEYCLOAK_REFRESH_TOKEN_COOKIE,
        tokenData.refresh_token,
        getCookieOptions(tokenData.refresh_expires_in || 60 * 60 * 24 * 30),
      );
    }

    // Set new ID token if provided
    if (tokenData.id_token) {
      response.cookies.set(
        KEYCLOAK_ID_TOKEN_COOKIE,
        tokenData.id_token,
        getCookieOptions(tokenData.expires_in),
      );
    }
    
    return response;
  } catch (error) {
    console.error("Middleware: Failed to refresh Keycloak token:", error);
    return null;
  }
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

    // For API routes: check if token needs refresh and set new cookies
    // Skip auth routes - they handle their own authentication
    if (request.nextUrl.pathname.startsWith("/api/") && 
        !request.nextUrl.pathname.startsWith("/api/auth/")) {
      const accessToken = request.cookies.get(KEYCLOAK_ACCESS_TOKEN_COOKIE)?.value;
      
      // If access token is expired or about to expire, try to refresh
      if (!accessToken || isTokenExpiredOrExpiring(accessToken)) {
        const refreshedResponse = await tryRefreshAndSetCookies(request);
        if (refreshedResponse) {
          return refreshedResponse;
        }
        // If refresh failed and no valid token, the API route will handle the error
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
  matcher: ["/", "/chat/:path*", "/api/:path*"],
};
