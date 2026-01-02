import { Octokit } from "@octokit/rest";
import { Endpoints } from "@octokit/types";

export type GithubUser = Endpoints["GET /user"]["response"]["data"];

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
 * Verifies a GitHub user access token with retry for transient errors.
 * @param accessToken The GitHub user access token.
 * @returns A promise that resolves with the user object if valid, otherwise undefined.
 */
export async function verifyGithubUser(
  accessToken: string,
  maxRetries = 3,
): Promise<GithubUser | undefined> {
  if (!accessToken) {
    return undefined;
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const octokit = new Octokit({ auth: accessToken });
      const { data: user } = await octokit.users.getAuthenticated();
      if (!user || !user.login) {
        return undefined;
      }
      return user;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (isTransientNetworkError(error) && attempt < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(
          `[verifyGithubUser] Transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`,
          lastError.message,
        );
        await sleep(delay);
        continue;
      }
      
      // Not retryable or max retries reached
      return undefined;
    }
  }
  
  return undefined;
}

/**
 * Verifies a GitHub user ID using the app installation token with retry for transient errors.
 * Checks that the provided user ID is valid, and the provided login matches the user's login.
 * @param installationToken The GitHub installation token.
 * @param userId The GitHub user ID.
 * @param userLogin The GitHub user login.
 * @returns A promise that resolves with the user object if valid, otherwise undefined.
 */
export async function verifyGithubUserId(
  installationToken: string,
  userId: number,
  userLogin: string,
  maxRetries = 3,
): Promise<GithubUser | undefined> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const octokit = new Octokit({ auth: installationToken });
      const { data: user } = await octokit.users.getById({ account_id: userId });
      if (!user || !user.login) {
        return undefined;
      }
      if (user.login !== userLogin) {
        return undefined;
      }
      return user;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (isTransientNetworkError(error) && attempt < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(
          `[verifyGithubUserId] Transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`,
          lastError.message,
        );
        await sleep(delay);
        continue;
      }
      
      // Not retryable or max retries reached
      return undefined;
    }
  }
  
  return undefined;
}
