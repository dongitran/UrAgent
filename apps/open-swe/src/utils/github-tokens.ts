import {
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_INSTALLATION_ID,
} from "@openswe/shared/constants";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { decryptSecret } from "@openswe/shared/crypto";
import { getGitHubPatFromConfig } from "./github-pat.js";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/**
 * Generate GitHub installation token using GitHub App credentials from environment
 */
async function generateGitHubInstallationToken(installationId: string): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error("Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY environment variables for token generation.");
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

  return data.token;
}

export async function getGitHubTokensFromConfig(config: GraphConfig): Promise<{
  githubAccessToken: string;
  githubInstallationToken: string;
  installationId: string;
}> {
  if (!config.configurable) {
    throw new Error("No configurable object found in graph config.");
  }

  // Get the encryption key from environment variables
  const encryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("Missing SECRETS_ENCRYPTION_KEY environment variable.");
  }

  const isProd = process.env.NODE_ENV === "production";

  const githubPat = getGitHubPatFromConfig(config.configurable, encryptionKey);
  if (githubPat && !isProd) {
    // check for PAT-only mode
    return {
      githubAccessToken: githubPat,
      githubInstallationToken: githubPat,
      // installationId is not required in PAT-only mode
      installationId: config.configurable[GITHUB_INSTALLATION_ID] ?? "",
    };
  }

  // Try to get installation ID from config or use default from env
  let installationId = config.configurable[GITHUB_INSTALLATION_ID];
  if (!installationId) {
    installationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
    if (!installationId) {
      throw new Error(
        `Missing required ${GITHUB_INSTALLATION_ID} in configuration and no DEFAULT_GITHUB_INSTALLATION_ID in env.`,
      );
    }
  }

  const encryptedGitHubToken = config.configurable[GITHUB_TOKEN_COOKIE];
  const encryptedInstallationToken =
    config.configurable[GITHUB_INSTALLATION_TOKEN_COOKIE];
  
  // If no encrypted tokens provided, try to generate using GitHub App credentials
  if (!encryptedInstallationToken) {
    // Check if we have GitHub App credentials to generate token
    if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
      const generatedToken = await generateGitHubInstallationToken(installationId);
      return {
        githubAccessToken: generatedToken,
        githubInstallationToken: generatedToken,
        installationId,
      };
    }
    throw new Error(
      `Missing required ${GITHUB_INSTALLATION_TOKEN_COOKIE} in configuration and no GitHub App credentials for auto-generation.`,
    );
  }

  // Decrypt the GitHub token
  const githubAccessToken = encryptedGitHubToken
    ? decryptSecret(encryptedGitHubToken, encryptionKey)
    : "";
  const githubInstallationToken = decryptSecret(
    encryptedInstallationToken,
    encryptionKey,
  );

  return { githubAccessToken, githubInstallationToken, installationId };
}
