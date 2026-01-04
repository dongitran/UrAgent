export const TIMEOUT_SEC = 60; // 1 minute

// Sandbox root directories for different providers
export const DAYTONA_SANDBOX_ROOT_DIR = "/home/daytona";
export const E2B_SANDBOX_ROOT_DIR = "/home/user";

// Legacy constant - defaults to Daytona path for backward compatibility
// Use getSandboxRootDir() for provider-aware path resolution
export const SANDBOX_ROOT_DIR = process.env.SANDBOX_ROOT_DIR || DAYTONA_SANDBOX_ROOT_DIR;

export const DAYTONA_IMAGE_NAME = "daytonaio/langchain-open-swe:0.1.0";
export const DAYTONA_SNAPSHOT_NAME =
  process.env.DAYTONA_SNAPSHOT_NAME || "open-swe-vcpu2-mem4-disk5";
// E2B template name - default to "base" which is E2B's default template
export const E2B_TEMPLATE_NAME =
  process.env.E2B_TEMPLATE || "base";

/**
 * Get the sandbox root directory based on provider type
 * @param providerType - 'daytona', 'e2b', 'local', or undefined (auto-detect from env)
 * @throws Error if providerType is 'multi' - caller should use sandbox.providerType instead
 */
export function getSandboxRootDir(providerType?: string): string {
  // If explicitly specified
  if (providerType === 'e2b') {
    return E2B_SANDBOX_ROOT_DIR;
  }
  if (providerType === 'daytona') {
    return DAYTONA_SANDBOX_ROOT_DIR;
  }
  if (providerType === 'local') {
    // Local mode doesn't use sandbox root dir, but return Daytona path as fallback
    return DAYTONA_SANDBOX_ROOT_DIR;
  }
  
  // 'multi' should never be passed here - caller should use sandbox.providerType
  // which returns the actual provider type ('daytona' or 'e2b')
  if (providerType === 'multi') {
    throw new Error(
      "getSandboxRootDir() cannot be called with 'multi' provider type. " +
      "Use sandbox.providerType to get the actual provider type after sandbox creation."
    );
  }
  
  // Auto-detect from environment (only when providerType not specified)
  const envProvider = process.env.SANDBOX_PROVIDER?.toLowerCase();
  if (envProvider === 'e2b') {
    return E2B_SANDBOX_ROOT_DIR;
  }
  if (envProvider === 'multi') {
    // When env is 'multi', we MUST have a providerType from sandbox instance
    // This error means caller forgot to pass sandboxProviderType from state
    throw new Error(
      "getSandboxRootDir() cannot auto-detect path when SANDBOX_PROVIDER=multi. " +
      "You must pass the actual providerType from sandbox instance (state.sandboxProviderType)."
    );
  }
  
  // Default to Daytona (when SANDBOX_PROVIDER is 'daytona' or not set)
  return DAYTONA_SANDBOX_ROOT_DIR;
}
export const PLAN_INTERRUPT_DELIMITER = ":::";
export const PLAN_INTERRUPT_ACTION_TITLE = "Approve/Edit Plan";

// Prefix the access token with `x-` so that it's included in requests to the LangGraph server.
export const GITHUB_TOKEN_COOKIE = "x-github-access-token";
export const GITHUB_INSTALLATION_TOKEN_COOKIE = "x-github-installation-token";
export const GITHUB_INSTALLATION_NAME = "x-github-installation-name";
export const GITHUB_PAT = "x-github-pat";
export const GITHUB_INSTALLATION_ID = "x-github-installation-id";
export const LOCAL_MODE_HEADER = "x-local-mode";
export const DO_NOT_RENDER_ID_PREFIX = "do-not-render-";
export const GITHUB_AUTH_STATE_COOKIE = "github_auth_state";
export const GITHUB_INSTALLATION_ID_COOKIE = "github_installation_id";
export const GITHUB_TOKEN_TYPE_COOKIE = "github_token_type";

export const OPEN_SWE_V2_GRAPH_ID = "open-swe-v2";
export const MANAGER_GRAPH_ID = "manager";
export const PLANNER_GRAPH_ID = "planner";
export const PROGRAMMER_GRAPH_ID = "programmer";

export const GITHUB_USER_ID_HEADER = "x-github-user-id";
export const GITHUB_USER_LOGIN_HEADER = "x-github-user-login";

export const DEFAULT_MCP_SERVERS = {
  "langgraph-docs-mcp": {
    command: "uvx",
    args: [
      "--from",
      "mcpdoc",
      "mcpdoc",
      "--urls",
      "LangGraphPY:https://langchain-ai.github.io/langgraph/llms.txt LangGraphJS:https://langchain-ai.github.io/langgraphjs/llms.txt",
      "--transport",
      "stdio",
    ],
    stderr: "inherit" as const,
  },
};

export const API_KEY_REQUIRED_MESSAGE =
  "Unknown users must provide API keys to use the UrAgent demo application";

export const OPEN_SWE_STREAM_MODE = [
  "values",
  "updates",
  "messages",
  "messages-tuple",
  "custom",
];
