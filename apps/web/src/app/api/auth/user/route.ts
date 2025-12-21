import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken } from "@/lib/auth";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";
import {
  getKeycloakAccessToken,
  getKeycloakUserInfo,
  decodeKeycloakToken,
  isKeycloakEnabled,
} from "@/lib/keycloak";

/**
 * Check if default GitHub configuration is available
 */
function hasDefaultConfig(): { hasConfig: boolean; installationName?: string } {
  const defaultInstallationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
  const defaultInstallationName = process.env.DEFAULT_GITHUB_INSTALLATION_NAME;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  const hasConfig = !!(defaultInstallationId && defaultInstallationName && appId && privateKey);
  return { hasConfig, installationName: defaultInstallationName };
}

export async function GET(request: NextRequest) {
  try {
    // Priority 1: Check Keycloak token if enabled
    if (isKeycloakEnabled()) {
      const keycloakToken = getKeycloakAccessToken(request);
      
      if (keycloakToken) {
        // Try to get user info from Keycloak
        const userInfo = await getKeycloakUserInfo(keycloakToken);
        
        if (userInfo) {
          return NextResponse.json({
            user: {
              id: userInfo.sub,
              login: userInfo.preferred_username,
              name: userInfo.name || userInfo.preferred_username,
              email: userInfo.email,
              avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(userInfo.preferred_username)}&background=random`,
            },
            authProvider: "keycloak",
          });
        }

        // Fallback: decode token directly
        const decoded = decodeKeycloakToken(keycloakToken);
        if (decoded) {
          return NextResponse.json({
            user: {
              id: decoded.sub,
              login: decoded.preferred_username,
              name: decoded.name || decoded.preferred_username,
              email: decoded.email,
              avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(decoded.preferred_username)}&background=random`,
            },
            authProvider: "keycloak",
          });
        }
      }
    }

    // Priority 2: Check GitHub OAuth token
    const token = getGitHubToken(request);
    
    if (token && token.access_token) {
      const user = await verifyGithubUser(token.access_token);
      if (user) {
        return NextResponse.json({
          user: {
            login: user.login,
            avatar_url: user.avatar_url,
            html_url: user.html_url,
            name: user.name,
            email: user.email,
          },
          authProvider: "github",
        });
      }
    }

    // Priority 3: Fall back to default config if available
    const { hasConfig, installationName } = hasDefaultConfig();
    if (hasConfig && installationName) {
      return NextResponse.json({
        user: {
          login: installationName,
          avatar_url: `https://github.com/${installationName}.png`,
          html_url: `https://github.com/${installationName}`,
          name: installationName,
          email: null,
        },
        isDefaultConfig: true,
        authProvider: "default",
      });
    }

    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  } catch (error) {
    console.error("Error in /api/auth/user:", error);
    return NextResponse.json(
      { error: "Failed to fetch user info" },
      { status: 500 },
    );
  }
}
