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
import { SandboxProviderType } from "./sandbox-provider/types.js";

const logger = createLogger(LogLevel.INFO, "Tree");

export const FAILED_TO_GENERATE_TREE_MESSAGE =
  "Failed to generate tree. Please try again.";

/**
 * Fallback tree command - outputs flat file paths which will be transformed to JSON nested format
 * Uses git ls-files + explicitly includes .skills folder if it exists
 * 
 * Output: Flat file paths (one per line), sorted alphabetically
 * These paths are then transformed to JSON nested format by transformToJsonNested()
 * which reduces token usage by ~66% compared to flat paths for deep nesting structures.
 * 
 * NOTE: To avoid duplicates, .skills files are collected via find -type f (files only),
 * and git ls-files excludes .skills folder.
 */
const FALLBACK_TREE_COMMAND = `{ 
  if [ -d .skills ]; then 
    find .skills -maxdepth 6 -type f 2>/dev/null; 
  fi; 
  git ls-files 2>/dev/null | grep -v '^.skills/'; 
  if [ ! -d .git ]; then 
    find . -maxdepth 6 -type f -not -path '*/.*' 2>/dev/null | sed 's|^./||'; 
  fi; 
} | sort -u | head -3000`;

/**
 * Transform flat file paths to nested no-quote format for maximum token efficiency
 * 
 * Input format:
 *   src/app.ts
 *   src/modules/user.ts
 * 
 * Output format (no-quote nested):
 *   {src:{_:[app.ts],modules:{_:[user.ts]}}}
 * 
 * This format avoids quotes which would be escaped as \" when embedded in JSON.
 * The "_" key contains array of files in that directory.
 * This saves ~64% vs flat paths and ~25% vs escaped JSON when embedded.
 */
function transformToJsonNested(flatPaths: string): string {
  const files = flatPaths.split('\n').filter(f => f.trim());

  if (files.length === 0) {
    return '{}';
  }

  // Build nested structure
  const root: Record<string, any> = {};

  for (const filepath of files) {
    const parts = filepath.split('/');
    let current = root;

    // Navigate/create directories
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }

    // Add file to "_" array
    const filename = parts[parts.length - 1];
    if (!('_' in current)) {
      current['_'] = [];
    }
    current['_'].push(filename);
  }

  // Convert to no-quote format (avoids \" escaping when embedded in JSON)
  return toNoQuoteFormat(root);
}

/**
 * Convert object to no-quote format string
 * Example: {key:{subkey:{_:[file1.ts,file2.ts]}}}
 */
function toNoQuoteFormat(obj: Record<string, any>): string {
  const items: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      // Array of files: _:[file1.ts,file2.ts]
      items.push(`${key}:[${value.join(',')}]`);
    } else if (typeof value === 'object' && value !== null) {
      // Nested directory
      items.push(`${key}:${toNoQuoteFormat(value)}`);
    } else {
      items.push(`${key}:${value}`);
    }
  }

  return '{' + items.join(',') + '}';
}

/**
 * Get the codebase tree for a repository
 * @param config - Graph configuration
 * @param sandboxSessionId_ - Optional sandbox session ID
 * @param targetRepository_ - Optional target repository
 * @param providerType_ - Optional provider type ('daytona' or 'e2b') for correct path resolution
 *                        Required when SANDBOX_PROVIDER=multi to avoid incorrect path
 */
export async function getCodebaseTree(
  config: GraphConfig,
  sandboxSessionId_?: string,
  targetRepository_?: TargetRepository,
  providerType_?: SandboxProviderType,
): Promise<string> {
  try {
    let sandboxSessionId = sandboxSessionId_;
    let targetRepository = targetRepository_;
    let providerType = providerType_;

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
    // providerType is required for correct path when SANDBOX_PROVIDER=multi
    const repoDir = getRepoAbsolutePath(targetRepository, undefined, providerType);

    logger.debug("[TREE] Generating tree", {
      repoDir,
      providerType,
      sandboxSessionId,
      hasTargetRepository: !!targetRepository,
    });

    // Use fallback command directly (tree is not available in E2B sandbox)
    // This uses git ls-files which is always available in git repos
    const response = await executor.executeCommand({
      command: FALLBACK_TREE_COMMAND,
      workdir: repoDir,
      timeout: TIMEOUT_SEC,
      sandboxSessionId,
    });

    let result = "";
    if (response.exitCode === 0 && response.result) {
      result = response.result;
    } else {
      logger.error("Failed to generate tree", {
        exitCode: response.exitCode,
        result: response.result ?? response.artifacts?.stdout,
        repoDir,
        providerType,
      });
      return FAILED_TO_GENERATE_TREE_MESSAGE;
    }

    // --- CHECK IF SKILLS ARE EXPECTED BUT MISSING ---
    let skillsExpected = !!(process.env.SKILLS_REPOSITORY_OWNER && process.env.SKILLS_REPOSITORY_NAME);

    // Also check config and state for skills repo
    if (!skillsExpected) {
      const configurable = config.configurable as any;
      if (configurable?.skillsRepository?.owner && configurable?.skillsRepository?.repo) {
        skillsExpected = true;
      } else {
        try {
          const state = getCurrentTaskInput<any>();
          if (state.skillsRepository?.owner && state.skillsRepository?.repo) {
            skillsExpected = true;
          }
        } catch {
          // ignore error if not in LangGraph context
        }
      }
    }

    // Check for .skills in flat paths format
    const skillsVisible = result.includes(".skills/");

    if (skillsExpected && !skillsVisible) {
      logger.warn("[TREE] Skills expected but not visible in tree, retrying after 1s delay...", {
        repoDir,
        providerType,
      });

      // Wait a bit and try one more time
      await new Promise(resolve => setTimeout(resolve, 1000));

      const retryResponse = await executor.executeCommand({
        command: FALLBACK_TREE_COMMAND,
        workdir: repoDir,
        timeout: TIMEOUT_SEC,
        sandboxSessionId,
      });

      if (retryResponse.exitCode === 0 && retryResponse.result) {
        if (retryResponse.result.includes(".skills/")) {
          logger.info("[TREE] Skills visible after retry");
        } else {
          logger.warn("[TREE] Skills still not visible after retry");
        }
        return transformToJsonNested(retryResponse.result);
      }
    }

    return transformToJsonNested(result);
  } catch (e) {
    const errorFields = getSandboxErrorFields(e);
    logger.error("Failed to generate tree (exception)", {
      ...(errorFields ? { errorFields } : {}),
      error: e instanceof Error ? e.message : String(e),
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
      return transformToJsonNested(response.result);
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
