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
 * Check if an error is a transient network error that should be retried
 */
function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;

    if (
      errorCode === "EAI_AGAIN" ||
      errorCode === "UND_ERR_CONNECT_TIMEOUT" ||
      message.includes("eai_again") ||
      message.includes("connect timeout") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("socket hang up") ||
      message.includes("fetch failed")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate GitHub installation token using GitHub App credentials from environment
 * Includes retry logic for transient network errors
 */
async function generateGitHubInstallationToken(
  installationId: string,
  maxRetries = 3,
): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error(
      "Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY environment variables for token generation.",
    );
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
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
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isTransientNetworkError(error) && attempt < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(
          `[generateGitHubInstallationToken] Transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`,
          lastError.message,
        );
        await sleep(delay);
        continue;
      }

      // Not retryable or max retries reached
      throw lastError;
    }
  }

  throw lastError || new Error("Max retries reached");
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

  // Check if installationId was corrupted by a token (common bug in previous versions)
  if (installationId && (installationId.startsWith("ghs_") || (installationId.length > 20 && !installationId.match(/^\d+$/)))) {
    console.warn(`[getGitHubTokensFromConfig] Detected corrupted installationId: ${installationId.substring(0, 10)}...`);
    // Try to fall back to environment default if possible
    if (process.env.DEFAULT_GITHUB_INSTALLATION_ID) {
      console.info(`[getGitHubTokensFromConfig] Recovering: Falling back to DEFAULT_GITHUB_INSTALLATION_ID: ${process.env.DEFAULT_GITHUB_INSTALLATION_ID}`);
      installationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
    } else {
      throw new Error(`Corrupted ${GITHUB_INSTALLATION_ID} found in configuration and no recovery possible.`);
    }
  }

  const encryptedGitHubToken = config.configurable[GITHUB_TOKEN_COOKIE];
  const encryptedInstallationToken =
    config.configurable[GITHUB_INSTALLATION_TOKEN_COOKIE];

  // Logic: Always prioritize fresh token generation if App credentials exist in the environment.
  // This prevents authentication failures when a session lasts longer than 1 hour (GITHUB IAT expiry).
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
    const generatedToken =
      await generateGitHubInstallationToken(installationId);
    return {
      githubAccessToken: generatedToken,
      githubInstallationToken: generatedToken,
      installationId,
    };
  }

  // Fallback to encrypted tokens from configuration if local App credentials are not available
  if (encryptedInstallationToken) {
    // Decrypt the GitHub token
    const githubAccessToken = encryptedGitHubToken
      ? decryptSecret(encryptedGitHubToken, encryptionKey)
      : "";
    const githubInstallationToken = decryptSecret(
      encryptedInstallationToken,
      encryptionKey,
    );

    return {
      githubAccessToken,
      githubInstallationToken,
      installationId,
    };
  }

  throw new Error(
    `Missing required ${GITHUB_INSTALLATION_TOKEN_COOKIE} in configuration and no GitHub App credentials for auto-generation.`,
  );
}
