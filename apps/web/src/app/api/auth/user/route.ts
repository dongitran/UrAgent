import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken } from "@/lib/auth";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";

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
    const token = getGitHubToken(request);
    
    // If we have OAuth token, use it
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
        });
      }
    }

    // Fall back to default config if available
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
      });
    }

    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch user info" },
      { status: 500 },
    );
  }
}
