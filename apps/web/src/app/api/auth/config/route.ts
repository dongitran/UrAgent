import { NextResponse } from "next/server";

export async function GET() {
  const keycloakUrl = process.env.NEXT_PUBLIC_KEYCLOAK_URL;
  const keycloakRealm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM;
  const keycloakClientId = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID;

  const keycloakEnabled = !!(keycloakUrl && keycloakRealm && keycloakClientId);

  return NextResponse.json({
    keycloakEnabled,
    keycloakUrl: keycloakEnabled ? keycloakUrl : undefined,
    keycloakRealm: keycloakEnabled ? keycloakRealm : undefined,
  });
}
