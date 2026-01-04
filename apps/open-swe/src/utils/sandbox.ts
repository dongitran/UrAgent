import { Daytona, Sandbox, SandboxState as DaytonaSandboxState } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "./logger.js";
import { GraphConfig, TargetRepository } from "@openswe/shared/open-swe/types";
import { DEFAULT_SANDBOX_CREATE_PARAMS, getDefaultTemplate, getDefaultUser } from "../constants.js";
import { getGitHubTokensFromConfig } from "./github-tokens.js";
import { cloneRepo } from "./github/git.js";
import { FAILED_TO_GENERATE_TREE_MESSAGE, getCodebaseTree } from "./tree.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import type { ISandbox, ISandboxProvider } from "./sandbox-provider/types.js";
import { SandboxState, SandboxProviderType } from "./sandbox-provider/types.js";
import { getSandboxProvider } from "./sandbox-provider/index.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";

const logger = createLogger(LogLevel.DEBUG, "Sandbox");

// Singleton instance of Daytona (kept for backward compatibility)
let daytonaInstance: Daytona | null = null;

// Singleton instance of provider
let providerInstance: ISandboxProvider | null = null;

/**
 * Returns a shared Daytona instance
 * @deprecated Use getProvider() for provider-agnostic sandbox management
 */
export function daytonaClient(): Daytona {
  if (!daytonaInstance) {
    logger.debug("[DAYTONA] Creating new Daytona client instance");
    daytonaInstance = new Daytona();
  }
  return daytonaInstance;
}

/**
 * Returns a shared sandbox provider instance
 * This is the new provider-agnostic way to manage sandboxes
 */
export function getProvider(): ISandboxProvider {
  if (!providerInstance) {
    logger.debug("[SANDBOX] Creating new provider instance");
    providerInstance = getSandboxProvider();
    logger.debug("[SANDBOX] Provider initialized", { name: providerInstance.name });
  }
  return providerInstance;
}

/**
 * Reset provider instance (useful for testing or switching providers)
 */
export function resetProvider(): void {
  providerInstance = null;
  daytonaInstance = null;
  logger.debug("[SANDBOX] Provider reset");
}

/**
 * Stops the sandbox. Either pass an existing sandbox client, or a sandbox session ID.
 * If no sandbox client is provided, the sandbox will be connected to.
 * @deprecated Use provider.stop() for provider-agnostic sandbox management
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
    sandbox.state === DaytonaSandboxState.STOPPED ||
    sandbox.state === DaytonaSandboxState.ARCHIVED
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
 * Deletes the sandbox using provider abstraction.
 * Works with both Daytona and E2B providers.
 * @param sandboxSessionId The ID of the sandbox to delete.
 * @returns True if the sandbox was deleted, false if it failed to delete.
 */
export async function deleteSandbox(
  sandboxSessionId: string,
): Promise<boolean> {
  const provider = getProvider();
  logger.debug("[SANDBOX] Deleting sandbox", { 
    sandboxSessionId,
    provider: provider.name,
  });
  const startTime = Date.now();

  try {
    const result = await provider.delete(sandboxSessionId);
    logger.debug("[SANDBOX] Sandbox deleted", {
      sandboxSessionId,
      result,
      provider: provider.name,
      durationMs: Date.now() - startTime,
    });
    return result;
  } catch (error) {
    logger.error("[SANDBOX] Failed to delete sandbox", {
      sandboxSessionId,
      provider: provider.name,
      durationMs: Date.now() - startTime,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
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
    const sandbox = await daytonaClient().create(
      DEFAULT_SANDBOX_CREATE_PARAMS,
      {
        timeout: 100, // 100s timeout on creation.
      },
    );
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
    logger.info(
      "[DAYTONA] Recreating sandbox due to error or unrecoverable state",
      {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : error,
      },
    );

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

/**
 * Provider-agnostic version of getSandboxWithErrorHandling
 * Returns ISandbox instead of native Daytona Sandbox
 * This is the new recommended way to get sandbox instances
 */
export async function getSandboxInstanceWithErrorHandling(
  sandboxSessionId: string | undefined,
  targetRepository: TargetRepository,
  branchName: string,
  config: GraphConfig,
): Promise<{
  sandboxInstance: ISandbox;
  codebaseTree: string | null;
  dependenciesInstalled: boolean | null;
}> {
  const provider = getProvider();
  
  logger.debug("[SANDBOX] getSandboxInstanceWithErrorHandling called", {
    sandboxSessionId,
    targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
    branchName,
    provider: provider.name,
    isLocalMode: isLocalMode(config),
  });

  if (isLocalMode(config)) {
    // In local mode, create a mock ISandbox
    const mockSandbox = {
      id: sandboxSessionId || "local-mock-sandbox",
      state: SandboxState.STARTED,
      executeCommand: async () => ({ exitCode: 0, result: "" }),
      readFile: async () => "",
      writeFile: async () => {},
      exists: async () => false,
      mkdir: async () => {},
      remove: async () => {},
      git: {
        clone: async () => {},
        add: async () => {},
        commit: async () => {},
        push: async () => {},
        pull: async () => {},
        createBranch: async () => {},
        status: async () => "",
      },
      start: async () => {},
      stop: async () => {},
      getNative: () => null as any,
    } as ISandbox;

    logger.debug("[SANDBOX] Local mode - returning mock sandbox", {
      mockSandboxId: mockSandbox.id,
    });

    return {
      sandboxInstance: mockSandbox,
      codebaseTree: null,
      dependenciesInstalled: null,
    };
  }

  try {
    if (!sandboxSessionId) {
      throw new Error("No sandbox ID provided.");
    }

    logger.debug("[SANDBOX] Getting existing sandbox via provider", { 
      sandboxSessionId,
      provider: provider.name,
    });
    const startTime = Date.now();

    // Try to get existing sandbox via provider
    const sandboxInstance = await provider.get(sandboxSessionId);

    logger.debug("[SANDBOX] Fetched existing sandbox", {
      sandboxSessionId,
      sandboxId: sandboxInstance.id,
      sandboxState: sandboxInstance.state,
      provider: provider.name,
      durationMs: Date.now() - startTime,
    });

    // Check sandbox state
    const state = sandboxInstance.state;

    if (state === SandboxState.STARTED) {
      logger.debug("[SANDBOX] Sandbox is already started, returning", {
        sandboxSessionId,
      });
      return {
        sandboxInstance,
        codebaseTree: null,
        dependenciesInstalled: null,
      };
    }

    if (state === SandboxState.STOPPED || state === SandboxState.ARCHIVED) {
      logger.debug("[SANDBOX] Sandbox is stopped/archived, starting it", {
        sandboxSessionId,
        state,
      });
      const startStartTime = Date.now();
      await sandboxInstance.start();
      logger.debug("[SANDBOX] Sandbox started successfully", {
        sandboxSessionId,
        durationMs: Date.now() - startStartTime,
      });
      return {
        sandboxInstance,
        codebaseTree: null,
        dependenciesInstalled: null,
      };
    }

    // For any other state, recreate sandbox
    throw new Error(`Sandbox in unrecoverable state: ${state}`);
  } catch (error) {
    // Recreate sandbox if any step fails
    logger.info(
      "[SANDBOX] Recreating sandbox due to error or unrecoverable state",
      {
        provider: provider.name,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : error,
      },
    );

    let sandboxInstance: ISandbox | null = null;
    let numSandboxCreateAttempts = 0;
    
    // Get the correct template based on provider type
    // For multi-provider, use E2B defaults (the provider handles actual selection)
    let providerType: SandboxProviderType;
    if (provider.name === 'multi') {
      providerType = SandboxProviderType.E2B; // Default for multi
    } else {
      providerType = provider.name === 'e2b' ? SandboxProviderType.E2B : SandboxProviderType.DAYTONA;
    }
    const template = getDefaultTemplate(providerType);
    const user = getDefaultUser(providerType);
    
    while (!sandboxInstance && numSandboxCreateAttempts < 3) {
      try {
        sandboxInstance = await provider.create({
          template,
          user,
          autoDeleteInterval: DEFAULT_SANDBOX_CREATE_PARAMS.autoDeleteInterval,
        });
      } catch (e) {
        logger.error("[SANDBOX] Failed to create sandbox", {
          attempt: numSandboxCreateAttempts,
          provider: provider.name,
          template,
          error: e instanceof Error ? e.message : String(e),
        });
        numSandboxCreateAttempts++;
      }
    }

    if (!sandboxInstance) {
      logger.error("[SANDBOX] Failed to create sandbox after 3 attempts");
      throw new Error("Failed to create sandbox after 3 attempts");
    }

    const { githubInstallationToken } = await getGitHubTokensFromConfig(config);
    
    // Get provider-aware path (reuse providerType from above)
    const absoluteRepoDir = getRepoAbsolutePath(targetRepository, undefined, provider.name);
    const cloneUrl = `https://github.com/${targetRepository.owner}/${targetRepository.repo}.git`;

    // Clone repository using ISandbox.git.clone()
    logger.debug("[SANDBOX] Cloning repository into new sandbox", {
      sandboxId: sandboxInstance.id,
      targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
      provider: provider.name,
    });
    
    await sandboxInstance.git.clone({
      url: cloneUrl,
      targetDir: absoluteRepoDir,
      branch: branchName || targetRepository.branch,
      commit: targetRepository.baseCommit,
      username: "x-access-token",
      token: githubInstallationToken,
      // Pass base branch for E2B to fetch reference (needed for git diff)
      baseBranch: targetRepository.branch,
    });

    // Create branch if needed
    if (branchName && branchName !== targetRepository.branch) {
      try {
        await sandboxInstance.git.createBranch(absoluteRepoDir, branchName);
        await sandboxInstance.git.push({
          workdir: absoluteRepoDir,
          username: "x-access-token",
          token: githubInstallationToken,
        });
      } catch (branchError) {
        logger.warn("[SANDBOX] Branch may already exist or failed to create", {
          branchName,
          error: branchError instanceof Error ? branchError.message : String(branchError),
        });
      }
    }

    // Get codebase tree
    const codebaseTree = await getCodebaseTree(
      config,
      sandboxInstance.id,
      targetRepository,
    );
    const codebaseTreeToReturn =
      codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE ? null : codebaseTree;

    logger.info("[SANDBOX] Sandbox created successfully", {
      sandboxId: sandboxInstance.id,
      sandboxState: sandboxInstance.state,
      provider: provider.name,
    });
    return {
      sandboxInstance,
      codebaseTree: codebaseTreeToReturn,
      dependenciesInstalled: false,
    };
  }
}

// Re-export types from sandbox-provider for convenience
export type {
  ISandbox,
  ISandboxProvider,
  ExecuteCommandResult,
  GitCloneOptions,
  CreateSandboxOptions,
} from "./sandbox-provider/types.js";

export {
  SandboxState as ProviderSandboxState,
  SandboxProviderType,
} from "./sandbox-provider/types.js";

// Re-export provider functions
export { getSandboxProvider, isProviderAvailable, getAvailableProviders } from "./sandbox-provider/index.js";
