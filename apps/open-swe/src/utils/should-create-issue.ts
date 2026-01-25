import { GraphConfig } from "@openswe/shared/open-swe/types";
import { getConfig } from "@openswe/shared/dynamic-config";

export function shouldCreateIssue(config: GraphConfig): boolean {
  // Check dynamic config first
  const envValue = getConfig("CREATE_GITHUB_ISSUES_FOR_REQUESTS");
  if (envValue === "false") {
    return false;
  }
  // Fall back to config
  return config.configurable?.shouldCreateIssue !== false;
}
