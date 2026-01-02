import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";

const replaceNewlinesWithBackslashN = (str: string) =>
  str.replace(/\n/g, "\\n");

// Retry configuration
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 3000; // 3 seconds
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // Add up to 1 second of jitter
  return Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY_MS);
}

/**
 * Check if an error is retryable (network errors, timeouts, server errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();
    
    // Timeout errors
    if (message.includes('timeout') || 
        message.includes('timed out') ||
        message.includes('connect_timeout') ||
        errorName.includes('timeout')) {
      return true;
    }
    // Network errors
    if (message.includes('fetch failed') || 
        message.includes('network') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('etimedout') ||
        message.includes('socket hang up') ||
        message.includes('und_err_connect_timeout')) {
      return true;
    }
    // Rate limit errors (429)
    if (message.includes('429') || message.includes('rate limit') || message.includes('quota')) {
      return true;
    }
    // Server errors (5xx)
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
      return true;
    }
  }
  return false;
}

/**
 * Execute a function with retry logic
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
        const delay = calculateRetryDelay(attempt);
        console.error(`[GitHubApp Retry] ${operationName} attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${delay}ms`, {
          error: lastError.message,
          errorName: lastError.name,
        });
        await sleep(delay);
      } else {
        console.error(`[GitHubApp Retry] ${operationName} failed after ${attempt + 1} attempts`, {
          error: lastError.message,
          errorName: lastError.name,
          isRetryable: isRetryableError(error),
        });
        throw lastError;
      }
    }
  }
  
  throw lastError || new Error(`Unknown error in ${operationName}`);
}

export class GitHubApp {
  app: App;

  constructor() {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
      ? replaceNewlinesWithBackslashN(process.env.GITHUB_APP_PRIVATE_KEY)
      : undefined;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!appId || !privateKey || !webhookSecret) {
      throw new Error(
        "GitHub App ID, Private Key, or Webhook Secret is not configured.",
      );
    }

    this.app = new App({
      appId,
      privateKey,
      webhooks: {
        secret: webhookSecret,
      },
    });
  }

  async getInstallationOctokit(installationId: number): Promise<Octokit> {
    return await withRetry(
      () => this.app.getInstallationOctokit(installationId),
      `getInstallationOctokit(${installationId})`,
    );
  }

  async getInstallationAccessToken(installationId: number): Promise<{
    token: string;
    expiresAt: string;
  }> {
    return await withRetry(async () => {
      const octokit = await this.app.getInstallationOctokit(installationId);

      // The installation access token is available on the auth property
      // Request specific permissions including workflows for creating/updating workflow files
      const auth = (await octokit.auth({
        type: "installation",
        permissions: {
          contents: "write",
          workflows: "write",
          pull_requests: "write",
          issues: "write",
          metadata: "read",
        },
      })) as any;

      return {
        token: auth.token,
        expiresAt: auth.expiresAt,
      };
    }, `getInstallationAccessToken(${installationId})`);
  }
}
