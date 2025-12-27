import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_TOKEN_COOKIE,
  GITHUB_USER_ID_HEADER,
  GITHUB_USER_LOGIN_HEADER,
  GITHUB_INSTALLATION_NAME,
  GITHUB_PAT,
  GITHUB_INSTALLATION_ID,
} from "@openswe/shared/constants";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/**
 * Cache for GitHub installation tokens to avoid repeated API calls
 * Token expires after 1 hour, so we cache for 50 minutes to be safe
 */
interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Generate GitHub installation token using GitHub App credentials from environment
 * Uses in-memory cache to avoid repeated API calls
 */
async function generateGitHubInstallationToken(
  installationId: string,
): Promise<string> {
  // Check cache first
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error(
      "Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY environment variables for token generation.",
    );
  }

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId: Number(installationId),
    },
  });

  const { data } = await octokit.apps.createInstallationAccessToken({
    installation_id: Number(installationId),
  });

  // Cache the token
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
  });

  return data.token;
}

export async function getDefaultHeaders(
  config: GraphConfig,
): Promise<Record<string, string>> {
  const githubPat = config.configurable?.[GITHUB_PAT];
  const isProd = process.env.NODE_ENV === "production";
  if (githubPat && !isProd) {
    // PAT-only
    return {
      [GITHUB_PAT]: githubPat,
    };
  }

  let githubInstallationTokenCookie =
    config.configurable?.[GITHUB_INSTALLATION_TOKEN_COOKIE];
  let githubInstallationName = config.configurable?.[GITHUB_INSTALLATION_NAME];
  let githubInstallationId = config.configurable?.[GITHUB_INSTALLATION_ID];

  // If missing required headers, try to use defaults from env and auto-generate token
  if (
    !githubInstallationTokenCookie ||
    !githubInstallationName ||
    !githubInstallationId
  ) {
    // Try to get installation ID from env
    if (!githubInstallationId) {
      githubInstallationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
    }

    // Try to get installation name from env or use default
    if (!githubInstallationName) {
      githubInstallationName =
        process.env.DEFAULT_GITHUB_INSTALLATION_NAME || "default";
    }

    // If we have GitHub App credentials and installation ID, generate token
    if (
      githubInstallationId &&
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY
    ) {
      if (!githubInstallationTokenCookie) {
        githubInstallationTokenCookie =
          await generateGitHubInstallationToken(githubInstallationId);
      }
    } else if (!githubInstallationTokenCookie) {
      throw new Error(
        "Missing required headers and no GitHub App credentials for auto-generation",
      );
    }
  }

  const githubTokenCookie = config.configurable?.[GITHUB_TOKEN_COOKIE] ?? "";
  const githubUserIdHeader = config.configurable?.[GITHUB_USER_ID_HEADER] ?? "";
  const githubUserLoginHeader =
    config.configurable?.[GITHUB_USER_LOGIN_HEADER] ?? "";

  return {
    // Required headers
    [GITHUB_INSTALLATION_TOKEN_COOKIE]: githubInstallationTokenCookie,
    [GITHUB_INSTALLATION_NAME]: githubInstallationName,
    [GITHUB_INSTALLATION_ID]: githubInstallationId || "",

    // Optional headers
    [GITHUB_TOKEN_COOKIE]: githubTokenCookie,
    [GITHUB_USER_ID_HEADER]: githubUserIdHeader,
    [GITHUB_USER_LOGIN_HEADER]: githubUserLoginHeader,
  };
}
