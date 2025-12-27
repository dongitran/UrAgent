import { Daytona, Sandbox, SandboxState } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "./logger.js";
import { GraphConfig, TargetRepository } from "@openswe/shared/open-swe/types";
import { DEFAULT_SANDBOX_CREATE_PARAMS } from "../constants.js";
import { getGitHubTokensFromConfig } from "./github-tokens.js";
import { cloneRepo } from "./github/git.js";
import { FAILED_TO_GENERATE_TREE_MESSAGE, getCodebaseTree } from "./tree.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";

const logger = createLogger(LogLevel.DEBUG, "Sandbox");

// Singleton instance of Daytona
let daytonaInstance: Daytona | null = null;

/**
 * Returns a shared Daytona instance
 */
export function daytonaClient(): Daytona {
  if (!daytonaInstance) {
    logger.debug("[DAYTONA] Creating new Daytona client instance");
    daytonaInstance = new Daytona();
  }
  return daytonaInstance;
}

/**
 * Stops the sandbox. Either pass an existing sandbox client, or a sandbox session ID.
 * If no sandbox client is provided, the sandbox will be connected to.
 
 * @param sandboxSessionId The ID of the sandbox to stop.
 * @param sandbox The sandbox client to stop. If not provided, the sandbox will be connected to.
 * @returns The sandbox session ID.
 */
export async function stopSandbox(sandboxSessionId: string): Promise<string> {
  logger.debug("[DAYTONA] Stopping sandbox", { sandboxSessionId });
  const startTime = Date.now();
  
  const sandbox = await daytonaClient().get(sandboxSessionId);
  logger.debug("[DAYTONA] Fetched sandbox for stopping", {
    sandboxSessionId,
    sandboxState: sandbox.state,
    durationMs: Date.now() - startTime,
  });
  
  if (
    sandbox.state === SandboxState.STOPPED ||
    sandbox.state === SandboxState.ARCHIVED
  ) {
    logger.debug("[DAYTONA] Sandbox already stopped/archived", {
      sandboxSessionId,
      state: sandbox.state,
    });
    return sandboxSessionId;
  } else if (sandbox.state === "started") {
    logger.debug("[DAYTONA] Stopping started sandbox", { sandboxSessionId });
    await daytonaClient().stop(sandbox);
    logger.debug("[DAYTONA] Sandbox stopped successfully", {
      sandboxSessionId,
      durationMs: Date.now() - startTime,
    });
  }

  return sandbox.id;
}

/**
 * Deletes the sandbox.
 * @param sandboxSessionId The ID of the sandbox to delete.
 * @returns True if the sandbox was deleted, false if it failed to delete.
 */
export async function deleteSandbox(
  sandboxSessionId: string,
): Promise<boolean> {
  logger.debug("[DAYTONA] Deleting sandbox", { sandboxSessionId });
  const startTime = Date.now();
  
  try {
    const sandbox = await daytonaClient().get(sandboxSessionId);
    logger.debug("[DAYTONA] Fetched sandbox for deletion", {
      sandboxSessionId,
      sandboxState: sandbox.state,
    });
    
    await daytonaClient().delete(sandbox);
    logger.debug("[DAYTONA] Sandbox deleted successfully", {
      sandboxSessionId,
      durationMs: Date.now() - startTime,
    });
    return true;
  } catch (error) {
    logger.error("[DAYTONA] Failed to delete sandbox", {
      sandboxSessionId,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
    });
    return false;
  }
}

async function createSandbox(attempt: number): Promise<Sandbox | null> {
  logger.debug("[DAYTONA] Creating new sandbox", {
    attempt,
    params: DEFAULT_SANDBOX_CREATE_PARAMS,
  });
  const startTime = Date.now();
  
  try {
    const sandbox = await daytonaClient().create(DEFAULT_SANDBOX_CREATE_PARAMS, {
      timeout: 100, // 100s timeout on creation.
    });
    logger.debug("[DAYTONA] Sandbox created successfully", {
      attempt,
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
      durationMs: Date.now() - startTime,
    });
    return sandbox;
  } catch (e) {
    logger.error("[DAYTONA] Failed to create sandbox", {
      attempt,
      durationMs: Date.now() - startTime,
      ...(e instanceof Error
        ? {
            name: e.name,
            message: e.message,
            stack: e.stack,
          }
        : {
            error: e,
          }),
    });
    return null;
  }
}

export async function getSandboxWithErrorHandling(
  sandboxSessionId: string | undefined,
  targetRepository: TargetRepository,
  branchName: string,
  config: GraphConfig,
): Promise<{
  sandbox: Sandbox;
  codebaseTree: string | null;
  dependenciesInstalled: boolean | null;
}> {
  logger.debug("[DAYTONA] getSandboxWithErrorHandling called", {
    sandboxSessionId,
    targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
    branchName,
    isLocalMode: isLocalMode(config),
  });

  if (isLocalMode(config)) {
    const mockSandbox = {
      id: sandboxSessionId || "local-mock-sandbox",
      state: "started",
    } as Sandbox;

    logger.debug("[DAYTONA] Local mode - returning mock sandbox", {
      mockSandboxId: mockSandbox.id,
    });

    return {
      sandbox: mockSandbox,
      codebaseTree: null,
      dependenciesInstalled: null,
    };
  }
  try {
    if (!sandboxSessionId) {
      throw new Error("No sandbox ID provided.");
    }

    logger.debug("[DAYTONA] Getting existing sandbox", { sandboxSessionId });
    const startTime = Date.now();
    
    // Try to get existing sandbox
    const sandbox = await daytonaClient().get(sandboxSessionId);
    
    logger.debug("[DAYTONA] Fetched existing sandbox", {
      sandboxSessionId,
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
      durationMs: Date.now() - startTime,
    });

    // Check sandbox state
    const state = sandbox.state;

    if (state === "started") {
      logger.debug("[DAYTONA] Sandbox is already started, returning", {
        sandboxSessionId,
      });
      return {
        sandbox,
        codebaseTree: null,
        dependenciesInstalled: null,
      };
    }

    if (state === "stopped" || state === "archived") {
      logger.debug("[DAYTONA] Sandbox is stopped/archived, starting it", {
        sandboxSessionId,
        state,
      });
      const startStartTime = Date.now();
      await sandbox.start();
      logger.debug("[DAYTONA] Sandbox started successfully", {
        sandboxSessionId,
        durationMs: Date.now() - startStartTime,
      });
      return {
        sandbox,
        codebaseTree: null,
        dependenciesInstalled: null,
      };
    }

    // For any other state, recreate sandbox
    throw new Error(`Sandbox in unrecoverable state: ${state}`);
  } catch (error) {
    // Recreate sandbox if any step fails
    logger.info("[DAYTONA] Recreating sandbox due to error or unrecoverable state", {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
      } : error,
    });

    let sandbox: Sandbox | null = null;
    let numSandboxCreateAttempts = 0;
    while (!sandbox && numSandboxCreateAttempts < 3) {
      sandbox = await createSandbox(numSandboxCreateAttempts);
      if (!sandbox) {
        numSandboxCreateAttempts++;
      }
    }

    if (!sandbox) {
      logger.error("[DAYTONA] Failed to create sandbox after 3 attempts");
      throw new Error("Failed to create sandbox after 3 attempts");
    }

    const { githubInstallationToken } = await getGitHubTokensFromConfig(config);

    // Clone repository
    logger.debug("[DAYTONA] Cloning repository into new sandbox", {
      sandboxId: sandbox.id,
      targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
    });
    await cloneRepo(sandbox, targetRepository, {
      githubInstallationToken,
      stateBranchName: branchName,
    });

    // Get codebase tree
    const codebaseTree = await getCodebaseTree(
      config,
      sandbox.id,
      targetRepository,
    );
    const codebaseTreeToReturn =
      codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE ? null : codebaseTree;

    logger.info("[DAYTONA] Sandbox created successfully", {
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
    });
    return {
      sandbox,
      codebaseTree: codebaseTreeToReturn,
      dependenciesInstalled: false,
    };
  }
}
