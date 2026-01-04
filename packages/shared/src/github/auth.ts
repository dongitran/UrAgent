import { generateJWT } from "../jwt.js";
import { fetchWithRetry } from "../utils/fetch-with-retry.js";

const convertEscapedNewlinesToNewlines = (str: string) =>
  str.replace(/\\n/g, "\n");

/**
 * In-memory cache for installation tokens
 * Token expires after 1 hour, we cache for 55 minutes to be safe
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const TOKEN_CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (tokens expire after 1 hour)

// Track in-flight token requests to prevent duplicate API calls
const pendingTokenRequests = new Map<string, Promise<string>>();

/**
 * Gets an installation access token for a GitHub App installation
 * Includes caching and retry logic for transient network errors
 */
export async function getInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
): Promise<string> {
  const cacheKey = `${installationId}:${appId}`;
  
  // Check cache first
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  
  // Check if there's already a pending request for this token
  const pendingRequest = pendingTokenRequests.get(cacheKey);
  if (pendingRequest) {
    return pendingRequest;
  }
  
  // Create new token request
  const tokenPromise = fetchInstallationToken(installationId, appId, privateKey);
  pendingTokenRequests.set(cacheKey, tokenPromise);
  
  try {
    const token = await tokenPromise;
    
    // Cache the token
    tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    });
    
    return token;
  } finally {
    // Clean up pending request
    pendingTokenRequests.delete(cacheKey);
  }
}

/**
 * Internal function to fetch installation token from GitHub API
 */
async function fetchInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
): Promise<string> {
  const jwtToken = generateJWT(
    appId,
    convertEscapedNewlinesToNewlines(privateKey),
  );

  const response = await fetchWithRetry(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "OpenSWE-Agent",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        permissions: {
          contents: "write",
          workflows: "write",
          pull_requests: "write",
          issues: "write",
          metadata: "read",
        },
      }),
    },
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      timeoutMs: 30000,
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      `Failed to get installation token: ${JSON.stringify(errorData)}`,
    );
  }

  const data = await response.json();
  if (typeof data !== "object" || !data || !("token" in data)) {
    throw new Error("No token returned after fetching installation token");
  }
  return data.token as string;
}

/**
 * Invalidate cached token for a specific installation
 * Useful when token is rejected by GitHub API
 */
export function invalidateInstallationToken(
  installationId: string,
  appId: string,
): void {
  const cacheKey = `${installationId}:${appId}`;
  tokenCache.delete(cacheKey);
}

/**
 * Clear all cached tokens
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Pre-warm token cache for known installation ID from environment
 * Call this on server startup to ensure first request is fast
 */
export async function warmupTokenCache(): Promise<boolean> {
  const installationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!installationId || !appId || !privateKey) {
    console.log("[Token Warmup] Skipped - missing env vars");
    return false;
  }

  try {
    await getInstallationToken(installationId, appId, privateKey);
    console.log(`[Token Warmup] Success - installation ${installationId}`);
    return true;
  } catch (error) {
    console.error("[Token Warmup] Failed:", error);
    return false;
  }
}

/**
 * Start background token refresh scheduler
 * Refreshes token every 25 minutes (before 1 hour expiry)
 */
let refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshScheduler(): void {
  if (refreshInterval) {
    return; // Already running
  }

  const REFRESH_INTERVAL_MS = 25 * 60 * 1000; // 25 minutes

  // Warm up immediately on start
  warmupTokenCache();

  // Schedule periodic refresh
  refreshInterval = setInterval(() => {
    warmupTokenCache();
  }, REFRESH_INTERVAL_MS);

  console.log("[Token Scheduler] Started - refresh every 25 minutes");
}

export function stopTokenRefreshScheduler(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log("[Token Scheduler] Stopped");
  }
}
