import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
} from "@openswe/shared/constants";
import { verifyGithubUser } from "@openswe/shared/github/verify-user";

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

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(GITHUB_TOKEN_COOKIE)?.value;
  const installationId = request.cookies.get(
    GITHUB_INSTALLATION_ID_COOKIE,
  )?.value;
  const user = token && installationId ? await verifyGithubUser(token) : null;

  // Check if we have default config (bypass OAuth)
  const useDefaultConfig = hasDefaultConfig();

  if (request.nextUrl.pathname === "/") {
    // If user is authenticated OR we have default config, redirect to chat
    if (user || useDefaultConfig) {
      const url = request.nextUrl.clone();
      url.pathname = "/chat";
      return NextResponse.redirect(url);
    }
  }

  if (request.nextUrl.pathname.startsWith("/chat")) {
    // Allow access if user is authenticated OR we have default config
    if (!user && !useDefaultConfig) {
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
