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
import { v4 as uuidv4 } from "uuid";
import { INITIALIZE_NODE_ID, CustomNodeEvent } from "@openswe/shared/open-swe/custom-node-events";
import { LocalSandbox } from "./sandbox-provider/local-provider.js";
import { isRunCancelled } from "./run-cancellation.js";

const logger = createLogger(LogLevel.DEBUG, "Sandbox");

/**
 * Helper to ensure the skills repository is cloned and available.
 * Skills are cloned into the main repository's .skills folder for easy access.
 */
export async function ensureSkillsRepository(
  sandboxInstance: ISandbox,
  mainRepoInfo: TargetRepository,
  config: GraphConfig,
  options?: {
    skillsRepoFromState?: TargetRepository;
    emitStepEvent?: (
      base: CustomNodeEvent,
      status: "pending" | "success" | "error" | "skipped",
      error?: string,
    ) => void;
  },
): Promise<TargetRepository | undefined> {
  const { skillsRepoFromState, emitStepEvent } = options || {};
  const configurable = config.configurable as unknown as {
    skillsRepository?: TargetRepository;
  };

  // Try to get skills repo from state, config, or fallback to env vars
  let skillsRepo = skillsRepoFromState || configurable?.skillsRepository;

  // Fallback to env vars if not provided in state or config
  if (!skillsRepo) {
    const envOwner = process.env.SKILLS_REPOSITORY_OWNER;
    const envRepo = process.env.SKILLS_REPOSITORY_NAME;
    if (envOwner && envRepo) {
      skillsRepo = {
        owner: envOwner,
        repo: envRepo,
        branch: process.env.SKILLS_REPOSITORY_BRANCH || "main",
      };
    }
  }

  if (skillsRepo) {
    const skillsCloneActionId = uuidv4();
    const skillsRepoName = `${skillsRepo.owner}/${skillsRepo.repo}`;
    const baseSkillsCloneAction: CustomNodeEvent = {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: skillsCloneActionId,
      action: "Cloning skills repository",
      data: {
        status: "pending",
        sandboxSessionId: sandboxInstance.id,
        branch: skillsRepo.branch,
        repo: skillsRepoName,
      },
    };

    emitStepEvent?.(baseSkillsCloneAction, "pending");

    try {
      const { githubInstallationToken } = isLocalMode(config)
        ? { githubInstallationToken: "" }
        : await getGitHubTokensFromConfig(config);

      // Clone skills into main repo .skills folder for easy relative path access
      const absoluteRepoDir = getRepoAbsolutePath(
        mainRepoInfo,
        undefined,
        sandboxInstance.providerType,
      );
      const skillsRepoDir = `${absoluteRepoDir}/.skills`;
      const skillsCloneUrl = `https://github.com/${skillsRepo.owner}/${skillsRepo.repo}.git`;

      // Check if skills repo already exists
      const skillsExists = await sandboxInstance.exists(skillsRepoDir);
      if (skillsExists) {
        logger.info("SKILLS REPO: Already exists, skipping clone", {
          targetDir: skillsRepoDir,
        });
        return skillsRepo;
      }

      logger.warn("SKILLS REPO: About to clone", {
        url: skillsCloneUrl,
        targetDir: skillsRepoDir,
        branch: skillsRepo.branch,
        providerType: sandboxInstance.providerType,
        absoluteRepoDir,
        sandboxId: sandboxInstance.id,
      });

      await sandboxInstance.git.clone({
        url: skillsCloneUrl,
        targetDir: skillsRepoDir,
        branch: skillsRepo.branch,
        baseBranch: skillsRepo.branch,
        username: "x-access-token",
        token: githubInstallationToken,
      });

      // Add .skills to .git/info/exclude to prevent accidental commits
      try {
        await sandboxInstance.executeCommand({
          command: `mkdir -p .git/info && echo ".skills" >> .git/info/exclude`,
          workdir: absoluteRepoDir,
        });
        logger.warn("SKILLS REPO: Added .skills to .git/info/exclude");
      } catch (excludeError) {
        logger.error("SKILLS REPO: Failed to add .skills to exclude", {
          error: excludeError,
        });
      }

      emitStepEvent?.(baseSkillsCloneAction, "success");
      logger.warn("SKILLS REPO: Clone SUCCESS", {
        targetDir: skillsRepoDir,
        branch: skillsRepo.branch,
      });
    } catch (error) {
      logger.warn("SKILLS REPO: Clone FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      emitStepEvent?.(
        baseSkillsCloneAction,
        "skipped",
        "Failed to clone skills repo, proceeding without it.",
      );
    }
  }

  return skillsRepo;
}

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
      if (await isRunCancelled(config)) {
        throw new Error("Run cancelled");
      }
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

    // Get codebase tree - this is Daytona-specific function so always use DAYTONA provider type
    const codebaseTree = await getCodebaseTree(
      config,
      sandbox.id,
      targetRepository,
      SandboxProviderType.DAYTONA,
    );
    const codebaseTreeToReturn =
      codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE ? null : codebaseTree;

    logger.info("[DAYTONA] Sandbox created successfully", {
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
    });

    // --- ENSURE SKILLS REPOSITORY IS CLONED ---
    await ensureSkillsRepository(
      {
        id: sandbox.id,
        state: SandboxState.STARTED,
        providerType: SandboxProviderType.DAYTONA,
        executeCommand: async (opts) => {
          const res = await sandbox.process.executeCommand(
            opts.command,
            opts.workdir,
            opts.env,
            opts.timeout,
          );
          return {
            exitCode: res.exitCode,
            result: res.result,
            artifacts: res.artifacts ? {
              stdout: res.artifacts.stdout || '',
              stderr: (res.artifacts as any).stderr,
            } : undefined,
          };
        },
        readFile: async (p) => {
          const res = await sandbox.process.executeCommand(`cat "${p}"`);
          if (res.exitCode !== 0) throw new Error(`Read failed: ${res.result}`);
          return res.result;
        },
        writeFile: async (p, c) => {
          const delimiter = `EOF_${Date.now()}`;
          const command = `cat > "${p}" << '${delimiter}'\n${c}\n${delimiter}`;
          const res = await sandbox.process.executeCommand(command);
          if (res.exitCode !== 0) throw new Error(`Write failed: ${res.result}`);
        },
        exists: async (p) => {
          const res = await sandbox.process.executeCommand(`test -e "${p}" && echo "exists" || echo "not_exists"`);
          return res.result.trim() === 'exists';
        },
        mkdir: async (p) => {
          const res = await sandbox.process.executeCommand(`mkdir -p "${p}"`);
          if (res.exitCode !== 0) throw new Error(`Mkdir failed: ${res.result}`);
        },
        remove: async (p) => {
          const res = await sandbox.process.executeCommand(`rm -rf "${p}"`);
          if (res.exitCode !== 0) throw new Error(`Remove failed: ${res.result}`);
        },
        git: {
          clone: async (o) => {
            const cloneUrl = o.token
              ? o.url.replace("https://", `https://${o.username || "x-access-token"}:${o.token}@`)
              : o.url;
            await sandbox.git.clone(cloneUrl, o.targetDir, o.branch, o.commit);
          },
          add: async (dir, files) => await sandbox.git.add(dir, files),
          commit: async (opts) => {
            await sandbox.git.commit(opts.workdir, opts.message, opts.authorName, opts.authorEmail);
          },
          push: async (opts) => await sandbox.git.push(opts.workdir),
          pull: async (opts) => await sandbox.git.pull(opts.workdir),
          createBranch: async (dir, name) => await sandbox.git.createBranch(dir, name),
          status: async (dir) => {
            const status = await sandbox.git.status(dir);
            return JSON.stringify(status);
          },
        },
        start: async () => { },
        stop: async () => { },
        getNative: <T>() => sandbox as unknown as T,
      },
      targetRepository,
      config,
    );

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
  sandboxProviderType?: string;
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
    // In local mode, use the real LocalSandbox
    const localSandbox = new LocalSandbox(
      sandboxSessionId || `local-${Date.now()}`,
    );

    logger.debug("[SANDBOX] Local mode - using LocalSandbox", {
      sandboxId: localSandbox.id,
    });

    // Ensure skills repo is available in local mode too!
    await ensureSkillsRepository(localSandbox, targetRepository, config);

    return {
      sandboxInstance: localSandbox,
      codebaseTree: null,
      dependenciesInstalled: null,
      sandboxProviderType: SandboxProviderType.LOCAL,
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
        sandboxProviderType: sandboxInstance.providerType,
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
        sandboxProviderType: sandboxInstance.providerType,
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

    // For multi-provider, it handles template/user selection internally based on selected sub-provider
    // For single providers, we determine the correct template/user based on provider type
    let createOptions: { template?: string; user?: string; autoDeleteInterval?: number };

    if (provider.name === 'multi') {
      // Multi-provider will determine correct template/user based on which provider it selects
      // We only pass autoDeleteInterval, let multi-provider handle the rest
      createOptions = {
        autoDeleteInterval: DEFAULT_SANDBOX_CREATE_PARAMS.autoDeleteInterval,
      };
      logger.debug("[SANDBOX] Using multi-provider (template/user will be auto-selected)");
    } else {
      // Single provider mode - determine template/user based on provider type
      const providerType = provider.name === 'e2b' ? SandboxProviderType.E2B : SandboxProviderType.DAYTONA;
      const template = getDefaultTemplate(providerType);
      const user = getDefaultUser(providerType);
      createOptions = {
        template,
        user,
        autoDeleteInterval: DEFAULT_SANDBOX_CREATE_PARAMS.autoDeleteInterval,
      };
      logger.debug("[SANDBOX] Using single provider", { provider: provider.name, template, user });
    }

    while (!sandboxInstance && numSandboxCreateAttempts < 3) {
      if (await isRunCancelled(config)) {
        throw new Error("Run cancelled");
      }
      try {
        sandboxInstance = await provider.create(createOptions);
      } catch (e) {
        logger.error("[SANDBOX] Failed to create sandbox", {
          attempt: numSandboxCreateAttempts,
          provider: provider.name,
          createOptions,
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

    // Get provider-aware path - MUST use sandboxInstance.providerType (not provider.name)
    // because in multi-provider mode, provider.name is 'multi' but sandboxInstance.providerType
    // is the actual provider ('daytona' or 'e2b')
    const absoluteRepoDir = getRepoAbsolutePath(targetRepository, undefined, sandboxInstance.providerType);
    const cloneUrl = `https://github.com/${targetRepository.owner}/${targetRepository.repo}.git`;

    // Clone repository using ISandbox.git.clone()
    logger.debug("[SANDBOX] Cloning repository into new sandbox", {
      sandboxId: sandboxInstance.id,
      targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
      provider: provider.name,
      actualProviderType: sandboxInstance.providerType,
      absoluteRepoDir,
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

    // Get codebase tree - use sandboxInstance.providerType for correct path
    const codebaseTree = await getCodebaseTree(
      config,
      sandboxInstance.id,
      targetRepository,
      sandboxInstance.providerType,
    );
    const codebaseTreeToReturn =
      codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE ? null : codebaseTree;

    logger.info("[SANDBOX] Sandbox created successfully", {
      sandboxId: sandboxInstance.id,
      sandboxState: sandboxInstance.state,
      provider: provider.name,
    });

    // --- ENSURE SKILLS REPOSITORY IS CLONED ---
    await ensureSkillsRepository(sandboxInstance, targetRepository, config);

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
