import { getSandboxRootDir } from "./constants.js";
import { TargetRepository, GraphConfig } from "./open-swe/types.js";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "./open-swe/local-mode.js";

/**
 * Get the absolute path to the repository in the sandbox
 * @param targetRepository - The target repository info
 * @param config - Optional graph config (used for local mode detection)
 * @param providerType - Optional provider type ('daytona', 'e2b') for explicit path resolution
 */
export function getRepoAbsolutePath(
  targetRepository: TargetRepository,
  config?: GraphConfig,
  providerType?: string,
): string {
  // Check for local mode first
  if (config && isLocalMode(config)) {
    return getLocalWorkingDirectory();
  }

  const repoName = targetRepository.repo;
  if (!repoName) {
    throw new Error("No repository name provided");
  }

  // Use provider-aware root directory
  const rootDir = getSandboxRootDir(providerType);
  return `${rootDir}/${repoName}`;
}
