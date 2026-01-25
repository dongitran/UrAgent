import { getConfig } from "@openswe/shared/dynamic-config";

export const GITHUB_TRIGGER_USERNAME = getConfig("GITHUB_TRIGGER_USERNAME")
  ? `@${getConfig("GITHUB_TRIGGER_USERNAME")}`
  : "@uragent";
