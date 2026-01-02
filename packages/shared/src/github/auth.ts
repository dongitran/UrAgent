import { generateJWT } from "../jwt.js";
import { fetchWithRetry } from "../utils/fetch-with-retry.js";

const convertEscapedNewlinesToNewlines = (str: string) =>
  str.replace(/\\n/g, "\n");

/**
 * Gets an installation access token for a GitHub App installation
 * Includes retry logic for transient network errors (DNS, timeout, etc.)
 */
export async function getInstallationToken(
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
