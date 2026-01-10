/**
 * Sandbox Adapter
 * 
 * This module provides backward compatibility with existing code that uses
 * the Daytona SDK directly. It wraps the new provider abstraction to maintain
 * the same interface as the original sandbox.ts module.
 * 
 * This allows gradual migration without breaking existing code.
 */

import { createLogger, LogLevel } from "../logger.js";
import { GraphConfig, TargetRepository } from "@openswe/shared/open-swe/types";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import {
  ISandbox,
  ISandboxProvider,
  SandboxProviderType,
  SandboxState,
  CreateSandboxOptions,
} from "./types.js";
import { getSandboxProvider } from "./index.js";
import { ensureSkillsRepository } from "../sandbox.js";

const logger = createLogger(LogLevel.DEBUG, "SandboxAdapter");

// Cache for provider instance
let cachedProvider: ISandboxProvider | null = null;

/**
 * Get the sandbox provider (cached)
 */
export function getProvider(): ISandboxProvider {
  if (!cachedProvider) {
    cachedProvider = getSandboxProvider();
    logger.debug("Sandbox provider initialized", { name: cachedProvider.name });
  }
  return cachedProvider;
}

/**
 * Set a specific provider (useful for testing or switching providers)
 */
export function setProvider(provider: ISandboxProvider): void {
  cachedProvider = provider;
  logger.debug("Sandbox provider set", { name: provider.name });
}

/**
 * Reset provider (force re-initialization)
 */
export function resetProvider(): void {
  cachedProvider = null;
  logger.debug("Sandbox provider reset");
}

/**
 * Create a new sandbox
 * Compatible with existing createSandbox usage
 */
export async function createSandbox(
  options?: CreateSandboxOptions,
): Promise<ISandbox> {
  const provider = getProvider();

  logger.debug("Creating sandbox via adapter", {
    provider: provider.name,
    options,
  });

  return provider.create(options);
}

/**
 * Get an existing sandbox by ID
 * Compatible with existing daytonaClient().get() usage
 */
export async function getSandbox(sandboxId: string): Promise<ISandbox> {
  const provider = getProvider();

  logger.debug("Getting sandbox via adapter", {
    provider: provider.name,
    sandboxId,
  });

  return provider.get(sandboxId);
}

/**
 * Stop a sandbox
 * Compatible with existing stopSandbox usage
 */
export async function stopSandbox(sandboxId: string): Promise<string> {
  const provider = getProvider();

  logger.debug("Stopping sandbox via adapter", {
    provider: provider.name,
    sandboxId,
  });

  await provider.stop(sandboxId);
  return sandboxId;
}

/**
 * Delete a sandbox
 * Compatible with existing deleteSandbox usage
 */
export async function deleteSandbox(sandboxId: string): Promise<boolean> {
  const provider = getProvider();

  logger.debug("Deleting sandbox via adapter", {
    provider: provider.name,
    sandboxId,
  });

  return provider.delete(sandboxId);
}

/**
 * Get sandbox with error handling and automatic recreation
 * Compatible with existing getSandboxWithErrorHandling usage
 */
export async function getSandboxWithErrorHandling(
  sandboxSessionId: string | undefined,
  targetRepository: TargetRepository,
  branchName: string,
  config: GraphConfig,
): Promise<{
  sandbox: ISandbox;
  codebaseTree: string | null;
  dependenciesInstalled: boolean | null;
}> {
  logger.debug("getSandboxWithErrorHandling called", {
    sandboxSessionId,
    targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
    branchName,
    isLocalMode: isLocalMode(config),
  });

  // Handle local mode
  if (isLocalMode(config)) {
    const mockSandbox = createMockLocalSandbox(sandboxSessionId);

    // Ensure skills repo is available in local mode too!
    await ensureSkillsRepository(mockSandbox, targetRepository, config);

    return {
      sandbox: mockSandbox,
      codebaseTree: null,
      dependenciesInstalled: null,
    };
  }

  const provider = getProvider();

  try {
    if (!sandboxSessionId) {
      throw new Error("No sandbox ID provided.");
    }

    // Try to get existing sandbox
    const sandbox = await provider.get(sandboxSessionId);
    const state = sandbox.state;

    if (state === SandboxState.STARTED) {
      logger.warn("Sandbox is already started, proceeding to ensure skills", { sandboxSessionId });
    } else if (state === SandboxState.STOPPED || state === SandboxState.ARCHIVED) {
      logger.debug("Sandbox is stopped/archived, starting it", { sandboxSessionId, state });
      await sandbox.start();
    } else {
      // For any other state, recreate sandbox
      throw new Error(`Sandbox in unrecoverable state: ${state}`);
    }

    // --- ENSURE SKILLS REPOSITORY IS CLONED ---
    await ensureSkillsRepository(sandbox, targetRepository, config);

    // Simple delay to ensure filesystem consistency
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // For legacy adapter, we return codebaseTree: null to maintain signature,
    // though the files are now available for subsequent tool calls.
    return {
      sandbox,
      codebaseTree: null,
      dependenciesInstalled: null,
    };
  } catch (error) {
    // Recreate sandbox if any step fails
    logger.info("Recreating sandbox due to error", {
      error: error instanceof Error ? error.message : String(error),
    });

    const sandbox = await createSandboxWithRetry(provider);

    // Clone repository - use provider-aware path from sandbox instance
    // sandbox.providerType gives us the actual provider ('daytona' or 'e2b')
    const absoluteRepoDir = getRepoAbsolutePath(targetRepository, undefined, sandbox.providerType);
    const cloneUrl = `https://github.com/${targetRepository.owner}/${targetRepository.repo}.git`;

    // Get GitHub token from config
    const githubToken = config.configurable?.["x-github-installation-token"];

    await sandbox.git.clone({
      url: cloneUrl,
      targetDir: absoluteRepoDir,
      branch: branchName,
      username: 'x-access-token', // GitHub requires x-access-token for installation tokens
      token: githubToken,
      // Pass base branch for E2B to fetch reference (needed for git diff)
      baseBranch: targetRepository.branch,
    });

    const skillsInstance: ISandbox = {
      id: sandbox.id,
      state: SandboxState.STARTED,
      providerType: sandbox.providerType,
      executeCommand: (o) => sandbox.executeCommand(o),
      readFile: (p) => sandbox.readFile(p),
      writeFile: (p, c) => sandbox.writeFile(p, c),
      exists: (p) => sandbox.exists(p),
      mkdir: (p) => sandbox.mkdir(p),
      remove: (p) => sandbox.remove(p),
      git: sandbox.git,
      start: () => sandbox.start(),
      stop: () => sandbox.stop(),
      getNative: () => sandbox.getNative(),
    };

    await ensureSkillsRepository(skillsInstance, targetRepository, config);

    return {
      sandbox,
      codebaseTree: null,
      dependenciesInstalled: false,
    };
  }
}

/**
 * Create sandbox with retry logic
 * For multi-provider, no options needed (it handles template/user internally)
 * For single providers, options should be passed by caller if needed
 */
async function createSandboxWithRetry(
  provider: ISandboxProvider,
  maxAttempts: number = 3,
): Promise<ISandbox> {
  let lastError: Error | undefined;

  // Multi-provider handles template/user selection internally
  // For single providers, they use their default template/user if not specified
  // This is safe because:
  // - MultiSandboxProvider.create() determines correct template based on selected sub-provider
  // - DaytonaSandboxProvider.create() uses defaultSnapshot if not specified
  // - E2BSandboxProvider.create() uses defaultTemplate if not specified

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await provider.create();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to create sandbox", {
        attempt: attempt + 1,
        provider: provider.name,
        error: lastError.message,
      });
    }
  }

  throw lastError ?? new Error(`Failed to create sandbox after ${maxAttempts} attempts`);
}

/**
 * Create a mock sandbox for local mode
 */
function createMockLocalSandbox(sandboxId?: string): ISandbox {
  const id = sandboxId || `local-mock-${Date.now()}`;

  return {
    id,
    state: SandboxState.STARTED,
    providerType: SandboxProviderType.LOCAL,

    async executeCommand() {
      throw new Error("Local mode: use LocalShellExecutor instead");
    },

    async readFile() {
      throw new Error("Local mode: use fs.readFile instead");
    },

    async writeFile() {
      throw new Error("Local mode: use fs.writeFile instead");
    },

    async exists() {
      throw new Error("Local mode: use fs.existsSync instead");
    },

    async mkdir() {
      throw new Error("Local mode: use fs.mkdirSync instead");
    },

    async remove() {
      throw new Error("Local mode: use fs.rmSync instead");
    },

    git: {
      async clone() {
        throw new Error("Local mode: use git CLI instead");
      },
      async add() {
        throw new Error("Local mode: use git CLI instead");
      },
      async commit() {
        throw new Error("Local mode: use git CLI instead");
      },
      async push() {
        throw new Error("Local mode: use git CLI instead");
      },
      async pull() {
        throw new Error("Local mode: use git CLI instead");
      },
      async createBranch() {
        throw new Error("Local mode: use git CLI instead");
      },
      async status() {
        throw new Error("Local mode: use git CLI instead");
      },
    },

    async start() {
      // No-op for local mode
    },

    async stop() {
      // No-op for local mode
    },

    getNative<T>(): T {
      return { id, state: 'started' } as unknown as T;
    },
  };
}

/**
 * Get current provider type
 */
export function getCurrentProviderType(): SandboxProviderType {
  const provider = getProvider();

  switch (provider.name) {
    case 'e2b':
      return SandboxProviderType.E2B;
    case 'daytona':
    default:
      return SandboxProviderType.DAYTONA;
  }
}
