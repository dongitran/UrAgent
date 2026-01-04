/**
 * Utility for fetch with retry logic to handle transient network errors
 * Handles: DNS resolution failures (EAI_AGAIN), connection timeouts, etc.
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  timeoutMs: 30000,
};

/**
 * Check if an error is retryable (transient network error)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;

    // DNS resolution errors
    if (errorCode === "EAI_AGAIN" || message.includes("eai_again")) {
      return true;
    }

    // Connection timeout errors
    if (
      errorCode === "UND_ERR_CONNECT_TIMEOUT" ||
      message.includes("connect timeout") ||
      message.includes("connecttimeouterror")
    ) {
      return true;
    }

    // Other transient errors
    if (
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("socket hang up") ||
      message.includes("network") ||
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
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
): number {
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter (±25%)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Fetch with automatic retry for transient errors
 */
export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Add timeout using AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Check if response status is retryable
      if (
        opts.retryableStatusCodes.includes(response.status) &&
        attempt < opts.maxRetries
      ) {
        const delay = calculateDelay(
          attempt,
          opts.initialDelayMs,
          opts.maxDelayMs,
          opts.backoffMultiplier,
        );
        console.warn(
          `[fetchWithRetry] Retryable status ${response.status} for ${url}, attempt ${attempt + 1}/${opts.maxRetries + 1}, retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (isRetryableError(error) && attempt < opts.maxRetries) {
        const delay = calculateDelay(
          attempt,
          opts.initialDelayMs,
          opts.maxDelayMs,
          opts.backoffMultiplier,
        );
        console.warn(
          `[fetchWithRetry] Transient error for ${url}, attempt ${attempt + 1}/${opts.maxRetries + 1}, retrying in ${delay}ms:`,
          lastError.message,
        );
        await sleep(delay);
        continue;
      }

      // Not retryable or max retries reached
      throw lastError;
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error("Max retries reached");
}

/**
 * Wrapper for GitHub API calls with retry
 * Uses shorter timeout for simple GET requests
 */
export async function fetchGitHubWithRetry(
  url: string | URL,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  // Use shorter timeout for GET requests (typically faster)
  const isGetRequest = !init?.method || init.method === "GET";
  const defaultTimeout = isGetRequest ? 15000 : 30000;
  
  return fetchWithRetry(url, init, {
    maxRetries: 3,
    initialDelayMs: 500, // Reduced from 1000ms for faster retry
    maxDelayMs: 5000,    // Reduced from 10000ms
    timeoutMs: defaultTimeout,
    ...options,
  });
}
