import { initApiPassthrough } from "langgraph-nextjs-api-passthrough";
import {
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_ID_COOKIE,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_INSTALLATION_NAME,
  GITHUB_INSTALLATION_ID,
} from "@openswe/shared/constants";
import {
  getGitHubInstallationTokenOrThrow,
  getInstallationNameFromReq,
  getGitHubAccessTokenOrThrow,
  verifyRequestAuth,
} from "./utils";
import { encryptSecret } from "@openswe/shared/crypto";

// This file acts as a proxy for requests to your LangGraph server.
// Web server verifies Keycloak/GitHub auth, then proxies to LangGraph internally (no auth needed)

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, runtime } =
  initApiPassthrough({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
    runtime: "nodejs", // Use nodejs to share cache with warmup
    disableWarningLog: true,
    bodyParameters: (req, body) => {
      if (body.config?.configurable && "apiKeys" in body.config.configurable) {
        const encryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
        if (!encryptionKey) {
          throw new Error(
            "SECRETS_ENCRYPTION_KEY environment variable is required",
          );
        }

        const apiKeys = body.config.configurable.apiKeys;
        const encryptedApiKeys: Record<string, unknown> = {};

        // Encrypt each field in the apiKeys object
        for (const [key, value] of Object.entries(apiKeys)) {
          if (typeof value === "string" && value.trim() !== "") {
            encryptedApiKeys[key] = encryptSecret(value, encryptionKey);
          } else {
            encryptedApiKeys[key] = value;
          }
        }

        // Update the body with encrypted apiKeys
        body.config.configurable.apiKeys = encryptedApiKeys;
        return body;
      }
      return body;
    },
    headers: async (req) => {
      const encryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error(
          "SECRETS_ENCRYPTION_KEY environment variable is required",
        );
      }

      // Verify authentication (Keycloak or GitHub or default config)
      const authResult = await verifyRequestAuth(req);
      if (!authResult.authenticated) {
        throw new Error(
          "Unauthorized: " + (authResult.error || "Not authenticated"),
        );
      }

      // Get installation ID from cookie or fall back to default from env
      let installationId = req.cookies.get(
        GITHUB_INSTALLATION_ID_COOKIE,
      )?.value;

      if (!installationId) {
        installationId = process.env.DEFAULT_GITHUB_INSTALLATION_ID;
      }

      if (!installationId) {
        throw new Error(
          "No GitHub installation ID found. GitHub App must be installed first.",
        );
      }

      const [installationToken, installationName] = await Promise.all([
        getGitHubInstallationTokenOrThrow(installationId, encryptionKey),
        getInstallationNameFromReq(req.clone(), installationId),
      ]);

      return {
        [GITHUB_TOKEN_COOKIE]: getGitHubAccessTokenOrThrow(req, encryptionKey),
        [GITHUB_INSTALLATION_TOKEN_COOKIE]: installationToken,
        [GITHUB_INSTALLATION_NAME]: installationName,
        [GITHUB_INSTALLATION_ID]: installationId,
      };
    },
  });
