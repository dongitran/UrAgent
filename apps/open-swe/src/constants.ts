import { DAYTONA_SNAPSHOT_NAME, E2B_TEMPLATE_NAME } from "@openswe/shared/constants";
import { CreateSandboxFromSnapshotParams } from "@daytonaio/sdk";
import { SandboxProviderType } from "./utils/sandbox-provider/types.js";

/**
 * Default Daytona sandbox creation parameters
 */
export const DEFAULT_SANDBOX_CREATE_PARAMS: CreateSandboxFromSnapshotParams = {
  user: "daytona",
  snapshot: DAYTONA_SNAPSHOT_NAME,
  autoDeleteInterval: 15, // delete after 15 minutes
};

/**
 * Default E2B sandbox creation parameters
 */
export const DEFAULT_E2B_SANDBOX_PARAMS = {
  template: E2B_TEMPLATE_NAME,
  timeout: 300, // 5 minutes
};

/**
 * Get the appropriate template/snapshot name based on provider type
 */
export function getDefaultTemplate(providerType: SandboxProviderType): string {
  switch (providerType) {
    case SandboxProviderType.E2B:
      return E2B_TEMPLATE_NAME;
    case SandboxProviderType.DAYTONA:
    default:
      return DAYTONA_SNAPSHOT_NAME;
  }
}

/**
 * Get the appropriate user based on provider type
 */
export function getDefaultUser(providerType: SandboxProviderType): string {
  switch (providerType) {
    case SandboxProviderType.E2B:
      return "user"; // E2B default user
    case SandboxProviderType.DAYTONA:
    default:
      return "daytona";
  }
}

export const LANGGRAPH_USER_PERMISSIONS = [
  "threads:create",
  "threads:create_run",
  "threads:read",
  "threads:delete",
  "threads:update",
  "threads:search",
  "assistants:create",
  "assistants:read",
  "assistants:delete",
  "assistants:update",
  "assistants:search",
  "deployments:read",
  "deployments:search",
  "store:access",
];

export enum RequestSource {
  GITHUB_ISSUE_WEBHOOK = "github_issue_webhook",
  GITHUB_PULL_REQUEST_WEBHOOK = "github_pull_request_webhook",
}
