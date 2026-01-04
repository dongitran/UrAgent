import { NextRequest, NextResponse } from "next/server";
import { getInstallationToken, invalidateInstallationToken } from "@openswe/shared/github/auth";
import { GITHUB_INSTALLATION_ID_COOKIE } from "@openswe/shared/constants";
import { fetchGitHubWithRetry } from "@openswe/shared/utils/fetch-with-retry";
import { githubApiCache } from "@/utils/cache";

const GITHUB_API_URL = "https://api.github.com";

// Cache TTL in seconds for different endpoints
const CACHE_TTL: Record<string, number> = {
  branches: 180,     // 3 minutes
  repos: 300,        // 5 minutes
  contents: 180,     // 3 minutes
  default: 180,      // 3 minutes default
};

function getCacheTTL(path: string): number {
  for (const [key, ttl] of Object.entries(CACHE_TTL)) {
    if (path.includes(key)) return ttl;
  }
  return CACHE_TTL.default;
}

function shouldCache(method: string, path: string): boolean {
  // Only cache GET requests for read-only endpoints
  if (method !== "GET") return false;
  
  // Cache branches, repos info, contents
  const cacheablePatterns = ["/branches", "/repos/", "/contents/"];
  return cacheablePatterns.some(pattern => path.includes(pattern));
}

async function handler(req: NextRequest) {
  const path = req.nextUrl.pathname.replace(/^\/api\/github\/proxy\//, "");
  const installationIdCookie = req.cookies.get(
    GITHUB_INSTALLATION_ID_COOKIE,
  )?.value;

  if (!installationIdCookie) {
    return NextResponse.json(
      { error: `"${GITHUB_INSTALLATION_ID_COOKIE}" cookie is required` },
      { status: 400 },
    );
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateAppKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateAppKey) {
    console.error("GitHub App ID or Private App Key is not configured.");
    return NextResponse.json(
      { error: `Missing required environment variables.` },
      { status: 500 },
    );
  }

  try {
    const token = await getInstallationToken(
      installationIdCookie,
      appId,
      privateAppKey,
    );

    const targetUrl = new URL(`${GITHUB_API_URL}/${path}`);

    // Forward query parameters from the original request
    req.nextUrl.searchParams.forEach((value, key) => {
      targetUrl.searchParams.append(key, value);
    });

    // Check cache for GET requests
    const cacheKey = `${installationIdCookie}:${targetUrl.toString()}`;
    if (shouldCache(req.method, path)) {
      const cachedData = githubApiCache.get<{ body: string; status: number; headers: Record<string, string> }>(cacheKey);
      if (cachedData) {
        const responseHeaders = new Headers(cachedData.headers);
        responseHeaders.set("X-Cache", "HIT");
        return new NextResponse(cachedData.body, {
          status: cachedData.status,
          headers: responseHeaders,
        });
      }
    }

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/vnd.github.v3+json");
    headers.set("User-Agent", "OpenSWE-Proxy");

    if (req.headers.has("Content-Type")) {
      headers.set("Content-Type", req.headers.get("Content-Type")!);
    }

    const response = await fetchGitHubWithRetry(targetUrl.toString(), {
      method: req.method,
      headers: headers,
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    // If token is rejected (401), invalidate cache and retry once
    if (response.status === 401) {
      invalidateInstallationToken(installationIdCookie, appId);
      
      // Get fresh token and retry
      const freshToken = await getInstallationToken(
        installationIdCookie,
        appId,
        privateAppKey,
      );
      
      headers.set("Authorization", `Bearer ${freshToken}`);
      
      const retryResponse = await fetchGitHubWithRetry(targetUrl.toString(), {
        method: req.method,
        headers: headers,
        body:
          req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });
      
      const retryResponseHeaders = new Headers(retryResponse.headers);
      retryResponseHeaders.delete("Content-Encoding");
      
      return new NextResponse(retryResponse.body, {
        status: retryResponse.status,
        statusText: retryResponse.statusText,
        headers: retryResponseHeaders,
      });
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("Content-Encoding"); // Prevent ERR_CONTENT_DECODING_FAILED error.

    // Cache successful GET responses
    if (shouldCache(req.method, path) && response.ok) {
      const responseBody = await response.text();
      const headersObj: Record<string, string> = {};
      responseHeaders.forEach((value, key) => {
        headersObj[key] = value;
      });
      
      githubApiCache.set(cacheKey, {
        body: responseBody,
        status: response.status,
        headers: headersObj,
      }, getCacheTTL(path));

      responseHeaders.set("X-Cache", "MISS");
      return new NextResponse(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Error in GitHub proxy:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to proxy request to GitHub", details: errorMessage },
      { status: 500 },
    );
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
