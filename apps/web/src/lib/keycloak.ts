import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

// Cookie names for Keycloak tokens
export const KEYCLOAK_ACCESS_TOKEN_COOKIE = "keycloak_access_token";
export const KEYCLOAK_REFRESH_TOKEN_COOKIE = "keycloak_refresh_token";
export const KEYCLOAK_ID_TOKEN_COOKIE = "keycloak_id_token";
export const KEYCLOAK_STATE_COOKIE = "keycloak_state";

// Keycloak configuration from environment
export function getKeycloakConfig() {
  return {
    url: process.env.NEXT_PUBLIC_KEYCLOAK_URL || "",
    realm: process.env.NEXT_PUBLIC_KEYCLOAK_REALM || "",
    clientId: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID || "",
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || "",
    redirectUri: process.env.KEYCLOAK_REDIRECT_URI || "",
  };
}

export function isKeycloakEnabled(): boolean {
  const config = getKeycloakConfig();
  return !!(config.url && config.realm && config.clientId);
}

export interface KeycloakTokenData {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  refresh_expires_in?: number;
  token_type: string;
}

export interface KeycloakUser {
  sub: string;
  preferred_username: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
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
 * Build Keycloak authorization URL
 */
export function buildKeycloakAuthUrl(state: string): string {
  const config = getKeycloakConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
  });

  return `${config.url}/realms/${config.realm}/protocol/openid-connect/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 * Supports both public clients (no secret) and confidential clients (with secret)
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<KeycloakTokenData> {
  const config = getKeycloakConfig();
  const tokenUrl = `${config.url}/realms/${config.realm}/protocol/openid-connect/token`;

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
  });

  // Only add client_secret if it's configured (confidential client)
  if (config.clientSecret) {
    params.append("client_secret", config.clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }

  return response.json();
}

/**
 * Refresh access token using refresh token
 * Supports both public clients (no secret) and confidential clients (with secret)
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<KeycloakTokenData> {
  const config = getKeycloakConfig();
  const tokenUrl = `${config.url}/realms/${config.realm}/protocol/openid-connect/token`;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });

  // Only add client_secret if it's configured (confidential client)
  if (config.clientSecret) {
    params.append("client_secret", config.clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Keycloak refresh token error:", {
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    });
    throw new Error(`Failed to refresh token: ${errorText}`);
  }

  return response.json();
}

/**
 * Store Keycloak tokens in cookies
 */
export function storeKeycloakTokens(
  tokenData: KeycloakTokenData,
  response: NextResponse,
): void {
  response.cookies.set(
    KEYCLOAK_ACCESS_TOKEN_COOKIE,
    tokenData.access_token,
    getCookieOptions(tokenData.expires_in),
  );

  if (tokenData.refresh_token) {
    response.cookies.set(
      KEYCLOAK_REFRESH_TOKEN_COOKIE,
      tokenData.refresh_token,
      getCookieOptions(tokenData.refresh_expires_in || 60 * 60 * 24 * 30), // 30 days default
    );
  }

  if (tokenData.id_token) {
    response.cookies.set(
      KEYCLOAK_ID_TOKEN_COOKIE,
      tokenData.id_token,
      getCookieOptions(tokenData.expires_in),
    );
  }
}

/**
 * Get Keycloak access token from request
 */
export function getKeycloakAccessToken(request: NextRequest): string | null {
  return request.cookies.get(KEYCLOAK_ACCESS_TOKEN_COOKIE)?.value || null;
}

/**
 * Get Keycloak refresh token from request
 */
export function getKeycloakRefreshToken(request: NextRequest): string | null {
  return request.cookies.get(KEYCLOAK_REFRESH_TOKEN_COOKIE)?.value || null;
}

/**
 * Clear Keycloak tokens from cookies
 */
export function clearKeycloakTokens(response: NextResponse): void {
  response.cookies.delete(KEYCLOAK_ACCESS_TOKEN_COOKIE);
  response.cookies.delete(KEYCLOAK_REFRESH_TOKEN_COOKIE);
  response.cookies.delete(KEYCLOAK_ID_TOKEN_COOKIE);
}

/**
 * Decode and verify Keycloak token (basic verification without public key)
 * For production, you should verify with Keycloak's public key
 */
export function decodeKeycloakToken(token: string): KeycloakUser | null {
  try {
    const decoded = jwt.decode(token) as KeycloakUser | null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Verify Keycloak token by introspection endpoint
 * Note: Token introspection requires client authentication for confidential clients
 * For public clients, we skip introspection and rely on token decoding
 */
export async function verifyKeycloakToken(token: string): Promise<boolean> {
  const config = getKeycloakConfig();

  // For public clients (no secret), we can't use introspection endpoint
  // Just decode and check expiration
  if (!config.clientSecret) {
    const decoded = decodeKeycloakToken(token);
    if (!decoded) return false;

    // Check if token has exp claim and is not expired
    const tokenData = decoded as any;
    if (tokenData.exp) {
      return tokenData.exp * 1000 > Date.now();
    }
    return true;
  }

  // For confidential clients, use introspection endpoint
  const introspectUrl = `${config.url}/realms/${config.realm}/protocol/openid-connect/token/introspect`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    token,
  });

  try {
    const response = await fetch(introspectUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.active === true;
  } catch {
    return false;
  }
}

/**
 * Get user info from Keycloak userinfo endpoint
 */
export async function getKeycloakUserInfo(
  accessToken: string,
): Promise<KeycloakUser | null> {
  const config = getKeycloakConfig();
  const userInfoUrl = `${config.url}/realms/${config.realm}/protocol/openid-connect/userinfo`;

  try {
    const response = await fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

/**
 * Build Keycloak logout URL
 */
export function buildKeycloakLogoutUrl(idToken?: string): string {
  const config = getKeycloakConfig();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const params = new URLSearchParams({
    post_logout_redirect_uri: appUrl,
  });

  if (idToken) {
    params.append("id_token_hint", idToken);
  }

  return `${config.url}/realms/${config.realm}/protocol/openid-connect/logout?${params.toString()}`;
}
