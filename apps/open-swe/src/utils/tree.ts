import { getCurrentTaskInput } from "@langchain/langgraph";
import {
  GraphState,
  TargetRepository,
  GraphConfig,
} from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "./logger.js";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import { getSandboxErrorFields } from "./sandbox-error-fields.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { createShellExecutor } from "./shell-executor/index.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";

const logger = createLogger(LogLevel.INFO, "Tree");

export const FAILED_TO_GENERATE_TREE_MESSAGE =
  "Failed to generate tree. Please try again.";

/**
 * Fallback tree command when 'tree' is not available
 * Uses git ls-files + awk to generate a tree-like structure
 * Shows directory structure with proper indentation
 */
const FALLBACK_TREE_COMMAND = `git ls-files | head -1000 | awk -F/ '
{
  # Track directories we have already printed
  path = ""
  for (i = 1; i < NF; i++) {
    path = (path == "" ? $i : path "/" $i)
    if (!(path in dirs)) {
      dirs[path] = 1
      indent = ""
      for (j = 1; j < i; j++) indent = indent "│   "
      print indent "├── " $i "/"
    }
  }
  # Print the file
  indent = ""
  for (j = 1; j < NF; j++) indent = indent "│   "
  print indent "├── " $NF
}' | head -500`;

export async function getCodebaseTree(
  config: GraphConfig,
  sandboxSessionId_?: string,
  targetRepository_?: TargetRepository,
): Promise<string> {
  try {
    let sandboxSessionId = sandboxSessionId_;
    let targetRepository = targetRepository_;

    // Check if we're in local mode
    if (isLocalMode(config)) {
      return getCodebaseTreeLocal(config);
    }

    // If sandbox session ID is not provided, try to get it from the current state.
    if (!sandboxSessionId || !targetRepository) {
      try {
        const state = getCurrentTaskInput<GraphState>();
        // Prefer the provided sandbox session ID and target repository. Fallback to state if defined.
        sandboxSessionId = sandboxSessionId ?? state.sandboxSessionId;
        targetRepository = targetRepository ?? state.targetRepository;
      } catch {
        // not executed in a LangGraph instance. continue.
      }
    }

    if (!sandboxSessionId) {
      logger.error("Failed to generate tree: No sandbox session ID provided");
      throw new Error("Failed generate tree: No sandbox session ID provided");
    }
    if (!targetRepository) {
      logger.error("Failed to generate tree: No target repository provided");
      throw new Error("Failed generate tree: No target repository provided");
    }

    const executor = createShellExecutor(config);
    // Use provider-aware path resolution via getRepoAbsolutePath
    // This automatically detects the provider from SANDBOX_PROVIDER env var
    const repoDir = getRepoAbsolutePath(targetRepository);
    
    // Use fallback command directly (tree is not available in E2B sandbox)
    // This uses git ls-files which is always available in git repos
    const response = await executor.executeCommand({
      command: FALLBACK_TREE_COMMAND,
      workdir: repoDir,
      timeout: TIMEOUT_SEC,
      sandboxSessionId,
    });

    if (response.exitCode === 0 && response.result) {
      return response.result;
    }

    // Fallback command failed
    logger.error("Failed to generate tree", {
      exitCode: response.exitCode,
      result: response.result ?? response.artifacts?.stdout,
      repoDir,
    });
    throw new Error(
      `Failed to generate tree: ${response.result ?? response.artifacts?.stdout}`,
    );
  } catch (e) {
    const errorFields = getSandboxErrorFields(e);
    logger.error("Failed to generate tree", {
      ...(errorFields ? { errorFields } : {}),
      ...(e instanceof Error
        ? {
            name: e.name,
            message: e.message,
            stack: e.stack,
          }
        : {}),
    });
    return FAILED_TO_GENERATE_TREE_MESSAGE;
  }
}

/**
 * Local version of getCodebaseTree using ShellExecutor
 */
async function getCodebaseTreeLocal(config: GraphConfig): Promise<string> {
  try {
    const executor = createShellExecutor(config);

    // Use fallback command directly (tree may not be available)
    const response = await executor.executeCommand({
      command: FALLBACK_TREE_COMMAND,
      timeout: TIMEOUT_SEC,
    });

    if (response.exitCode === 0 && response.result) {
      return response.result;
    }

    logger.error("Failed to generate tree in local mode", {
      exitCode: response.exitCode,
      result: response.result,
    });
    throw new Error(
      `Failed to generate tree in local mode: ${response.result}`,
    );
  } catch (e) {
    logger.error("Failed to generate tree in local mode", {
      ...(e instanceof Error
        ? {
            name: e.name,
            message: e.message,
            stack: e.stack,
          }
        : { error: e }),
    });
    return FAILED_TO_GENERATE_TREE_MESSAGE;
  }
}
