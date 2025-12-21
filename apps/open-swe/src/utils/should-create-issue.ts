import { GraphConfig } from "@openswe/shared/open-swe/types";

export function shouldCreateIssue(config: GraphConfig): boolean {
  // Check env variable first
  const envValue = process.env.CREATE_GITHUB_ISSUES_FOR_REQUESTS;
  if (envValue === "false") {
    return false;
  }
  // Fall back to config
  return config.configurable?.shouldCreateIssue !== false;
}
