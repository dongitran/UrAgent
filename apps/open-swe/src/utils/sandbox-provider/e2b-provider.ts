/**
 * E2B Sandbox Provider Implementation
 * 
 * Wraps the E2B SDK to implement the ISandboxProvider interface
 * 
 * E2B SDK API Reference:
 * - Sandbox.create(template?, opts?) - Create new sandbox
 * - Sandbox.connect(sandboxId, opts?) - Connect to existing sandbox
 * - Sandbox.kill(sandboxId, opts?) - Kill sandbox by ID
 * - Sandbox.list(opts?) - List all sandboxes
 * 
 * Sandbox instance:
 * - sandbox.commands.run(cmd, opts?) - Execute command
 * - sandbox.files.read(path, opts?) - Read file
 * - sandbox.files.write(path, data, opts?) - Write file
 * - sandbox.files.exists(path, opts?) - Check if exists
 * - sandbox.files.makeDir(path, opts?) - Create directory
 * - sandbox.files.remove(path, opts?) - Remove file/dir
 * - sandbox.kill(opts?) - Kill sandbox
 * - sandbox.setTimeout(timeoutMs, opts?) - Set timeout
 */

import { createLogger, LogLevel } from "../logger.js";
import { isRunCancelled } from "../run-cancellation.js";
import {
  ISandbox,
  ISandboxProvider,
  SandboxState,
  SandboxInfo,
  CreateSandboxOptions,
  ExecuteCommandOptions,
  ExecuteCommandResult,
  GitCloneOptions,
  GitOperationOptions,
  GitCommitOptions,
  SandboxProviderType,
} from "./types.js";

const logger = createLogger(LogLevel.DEBUG, "E2BSandboxProvider");

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket') ||
      message.includes('fetch failed') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')
    );
  }
  return false;
}

// E2B SDK types (dynamic import to avoid hard dependency)
type E2BSandbox = {
  sandboxId: string;
  commands: {
    run(cmd: string, opts?: {
      cwd?: string;
      envs?: Record<string, string>;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    }): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  files: {
    read(path: string, opts?: { format?: 'text' | 'bytes' }): Promise<string>;
    write(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    makeDir(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
  };
  kill(): Promise<void>;
  setTimeout(timeoutMs: number): Promise<void>;
  isRunning(): Promise<boolean>;
};

type E2BSandboxCreateOpts = {
  apiKey?: string;
  timeoutMs?: number;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
};

type E2BSandboxClass = {
  // Overload 1: Create with default template (no template argument)
  create(opts?: E2BSandboxCreateOpts): Promise<E2BSandbox>;
  // Overload 2: Create with custom template
  create(template: string, opts?: E2BSandboxCreateOpts): Promise<E2BSandbox>;
  connect(sandboxId: string, opts?: { apiKey?: string }): Promise<E2BSandbox>;
  kill(sandboxId: string, opts?: { apiKey?: string }): Promise<boolean>;
  list(opts?: { apiKey?: string }): Promise<Array<{
    sandboxId: string;
    templateId?: string;
    startedAt?: string;
    metadata?: Record<string, string>;
  }>>;
};

/**
 * E2B Sandbox wrapper implementing ISandbox
 */
export class E2BSandboxWrapper implements ISandbox {
  private sandbox: E2BSandbox;
  private _state: SandboxState = SandboxState.STARTED;

  constructor(sandbox: E2BSandbox) {
    this.sandbox = sandbox;
  }

  get id(): string {
    return this.sandbox.sandboxId;
  }

  get state(): SandboxState {
    return this._state;
  }

  get providerType(): SandboxProviderType {
    return SandboxProviderType.E2B;
  }

  async executeCommand(options: ExecuteCommandOptions): Promise<ExecuteCommandResult> {
    const { command, workdir, env, timeout = 30 } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Check for cancellation before each retry attempt
      if (options.config && await isRunCancelled(options.config)) {
        throw new Error("Run cancelled");
      }
      try {
        logger.debug("[E2B] Executing command", {
          sandboxId: this.id,
          command: command.length > 200 ? command.substring(0, 200) + '...' : command,
          workdir,
          attempt: attempt + 1,
          timeout,
        });

        const startTime = Date.now();

        // Collect stdout/stderr during execution
        let stdout = '';
        let stderr = '';

        const response = await this.sandbox.commands.run(command, {
          cwd: workdir,
          envs: env,
          timeoutMs: timeout * 1000,
          onStdout: (data: string) => { stdout += data; },
          onStderr: (data: string) => { stderr += data; },
        });

        const duration = Date.now() - startTime;
        logger.debug("[E2B] Command completed", {
          sandboxId: this.id,
          durationMs: duration,
          exitCode: response.exitCode,
          stdoutLen: (response.stdout || stdout).length,
          stderrLen: (response.stderr || stderr).length,
        });

        // Log warning if command failed
        if (response.exitCode !== 0) {
          logger.warn("[E2B] Command returned non-zero exit code", {
            sandboxId: this.id,
            exitCode: response.exitCode,
            command: command.length > 100 ? command.substring(0, 100) + '...' : command,
            stdout: (response.stdout || stdout).substring(0, 300),
            stderr: (response.stderr || stderr).substring(0, 300),
          });
        }

        return {
          exitCode: response.exitCode,
          result: response.stdout || response.stderr || stdout || stderr,
          artifacts: {
            stdout: response.stdout || stdout,
            stderr: response.stderr || stderr,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this is a CommandExitError (non-zero exit code)
        // E2B SDK throws this instead of returning exitCode
        const errorAny = error as any;
        if (errorAny?.exitCode !== undefined || lastError.name === 'CommandExitError') {
          const exitCode = errorAny?.exitCode ?? 128;
          const stdout = errorAny?.stdout || '';
          const stderr = errorAny?.stderr || '';

          logger.warn("[E2B] Command exited with error (caught as exception)", {
            sandboxId: this.id,
            exitCode,
            command: command.length > 100 ? command.substring(0, 100) + '...' : command,
            stdout: stdout.substring(0, 300),
            stderr: stderr.substring(0, 300),
            errorMessage: lastError.message,
          });

          // Return as result instead of throwing
          return {
            exitCode,
            result: stderr || stdout || lastError.message,
            artifacts: {
              stdout,
              stderr,
            },
          };
        }

        if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.warn("[E2B] Command failed with retryable error, retrying...", {
            sandboxId: this.id,
            attempt: attempt + 1,
            retryDelayMs: delay,
            error: lastError.message,
          });
          await sleep(delay);
          continue;
        }

        logger.error("[E2B] Command failed with non-retryable error", {
          sandboxId: this.id,
          command: command.length > 200 ? command.substring(0, 200) + '...' : command,
          error: lastError.message,
          stack: lastError.stack?.substring(0, 500),
        });
        throw error;
      }
    }

    throw lastError ?? new Error("Unknown error in executeCommand");
  }

  async readFile(path: string): Promise<string> {
    try {
      return await this.sandbox.files.read(path, { format: 'text' });
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      await this.sandbox.files.write(path, content);
    } catch (error) {
      throw new Error(`Failed to write file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.sandbox.files.exists(path);
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.sandbox.files.makeDir(path);
    } catch (error) {
      throw new Error(`Failed to create directory ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.sandbox.files.remove(path);
    } catch (error) {
      throw new Error(`Failed to remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Extend sandbox timeout/lifetime
   * E2B allows extending sandbox lifetime up to 24 hours for Pro users, 1 hour for Hobby
   */
  async extendTimeout(timeoutMs: number): Promise<void> {
    try {
      logger.debug("[E2B] Extending sandbox timeout", {
        sandboxId: this.id,
        timeoutMs,
      });
      await this.sandbox.setTimeout(timeoutMs);
      logger.info("[E2B] Sandbox timeout extended", {
        sandboxId: this.id,
        timeoutMs,
      });
    } catch (error) {
      logger.warn("[E2B] Failed to extend sandbox timeout", {
        sandboxId: this.id,
        timeoutMs,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - this is a best-effort operation
    }
  }

  /**
   * Git operations - E2B doesn't have native git support,
   * so we implement via shell commands
   */
  git = {
    clone: async (options: GitCloneOptions): Promise<void> => {
      logger.info("[E2B] Git clone starting", {
        sandboxId: this.id,
        url: options.url.replace(/\/\/.*@/, '//***@'),
        targetDir: options.targetDir,
        branch: options.branch,
        baseBranch: options.baseBranch,
        hasToken: !!options.token,
        hasCommit: !!options.commit,
      });

      // Step 1: Ensure git is installed
      logger.debug("[E2B] Checking git installation");
      const gitCheck = await this.executeCommand({
        command: 'which git',
        timeout: 30,
      });

      if (gitCheck.exitCode !== 0) {
        logger.info("[E2B] Git not found, installing...");
        const installResult = await this.executeCommand({
          command: 'apt-get update && apt-get install -y git',
          timeout: 180,
        });

        if (installResult.exitCode !== 0) {
          logger.error("[E2B] Failed to install git", {
            sandboxId: this.id,
            exitCode: installResult.exitCode,
            stderr: installResult.artifacts?.stderr?.substring(0, 500),
          });
          throw new Error(`Failed to install git: ${installResult.artifacts?.stderr || installResult.result}`);
        }
        logger.info("[E2B] Git installed successfully");
      } else {
        logger.debug("[E2B] Git is already installed", {
          gitPath: gitCheck.result?.trim(),
        });
      }

      // Step 2: Create parent directory if needed
      const parentDir = options.targetDir.split('/').slice(0, -1).join('/');
      if (parentDir) {
        logger.debug("[E2B] Creating parent directory", { parentDir });
        await this.executeCommand({
          command: `mkdir -p "${parentDir}"`,
          timeout: 30,
        });
      }

      // Step 3: Build clone URL with credentials if provided
      let cloneUrl = options.url;
      if (options.token) {
        const urlMatch = options.url.match(/^(https?:\/\/)(.+)$/);
        if (urlMatch) {
          const protocol = urlMatch[1];
          const rest = urlMatch[2];
          const username = options.username || 'x-access-token';
          const encodedToken = encodeURIComponent(options.token);
          cloneUrl = `${protocol}${username}:${encodedToken}@${rest}`;
          logger.debug("[E2B] Built authenticated clone URL", {
            username,
            hasEncodedToken: true,
          });
        }
      }

      // Step 4: Always clone base branch first to ensure local base branch exists for git diff
      // This matches the behavior of the old code that worked correctly
      const baseBranch = options.baseBranch || 'main';

      logger.info("[E2B] Cloning base branch first", {
        sandboxId: this.id,
        baseBranch,
      });

      let command = `git clone --depth 1 -b "${baseBranch}" "${cloneUrl}" "${options.targetDir}"`;

      logger.debug("[E2B] Executing git clone", {
        sandboxId: this.id,
        command: command.replace(/\/\/[^@]+@/, '//***@'),
      });

      let result = await this.executeCommand({
        command,
        timeout: 300,
        env: {
          GIT_TERMINAL_PROMPT: '0',
        },
      });

      if (result.exitCode !== 0) {
        logger.error("[E2B] Git clone failed", {
          sandboxId: this.id,
          exitCode: result.exitCode,
          stdout: result.artifacts?.stdout?.substring(0, 500),
          stderr: result.artifacts?.stderr?.substring(0, 500),
          result: result.result?.substring(0, 500),
        });
        throw new Error(`Git clone failed (exit ${result.exitCode}): ${result.artifacts?.stderr || result.result}`);
      }

      logger.info("[E2B] Cloned base branch successfully", {
        sandboxId: this.id,
        baseBranch,
      });

      // Step 5: If a different branch is requested, create/checkout it
      if (options.branch && options.branch !== baseBranch) {
        logger.info("[E2B] Creating/checking out feature branch", {
          sandboxId: this.id,
          featureBranch: options.branch,
          baseBranch,
        });

        // Try to checkout existing branch first, if fails create new branch
        const checkoutResult = await this.executeCommand({
          command: `git checkout ${options.branch} 2>/dev/null || git checkout -b ${options.branch}`,
          workdir: options.targetDir,
          timeout: 60,
        });

        if (checkoutResult.exitCode !== 0) {
          logger.warn("[E2B] Failed to checkout/create branch", {
            sandboxId: this.id,
            branch: options.branch,
            stderr: checkoutResult.artifacts?.stderr?.substring(0, 300),
          });
        } else {
          logger.info("[E2B] Feature branch ready", {
            sandboxId: this.id,
            branch: options.branch,
          });
        }
      }

      // Step 6: Fetch full history if we need to checkout a specific commit
      if (options.commit) {
        logger.debug("[E2B] Fetching full history for commit checkout");
        await this.executeCommand({
          command: 'git fetch --unshallow || true',
          workdir: options.targetDir,
          timeout: 300,
        });

        const checkoutResult = await this.executeCommand({
          command: `git checkout ${options.commit}`,
          workdir: options.targetDir,
          timeout: 60,
        });

        if (checkoutResult.exitCode !== 0) {
          logger.error("[E2B] Git checkout failed", {
            sandboxId: this.id,
            commit: options.commit,
            exitCode: checkoutResult.exitCode,
            stderr: checkoutResult.artifacts?.stderr?.substring(0, 500),
          });
          throw new Error(`Git checkout failed: ${checkoutResult.artifacts?.stderr || checkoutResult.result}`);
        }

        logger.debug("[E2B] Checked out commit", { commit: options.commit });
      }
    },

    add: async (workdir: string, files: string[]): Promise<void> => {
      const fileList = files.map(f => `"${f}"`).join(' ');
      const result = await this.executeCommand({
        command: `git add ${fileList}`,
        workdir,
        timeout: 60,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Git add failed: ${result.result}`);
      }
    },

    commit: async (options: GitCommitOptions): Promise<void> => {
      // Set git config - run as separate commands
      await this.executeCommand({
        command: `git config user.name "${options.authorName}"`,
        workdir: options.workdir,
        timeout: 30,
      });

      await this.executeCommand({
        command: `git config user.email "${options.authorEmail}"`,
        workdir: options.workdir,
        timeout: 30,
      });

      const result = await this.executeCommand({
        command: `git commit -m "${options.message.replace(/"/g, '\\"')}"`,
        workdir: options.workdir,
        timeout: 60,
      });

      if (result.exitCode !== 0 && !result.result.includes('nothing to commit')) {
        throw new Error(`Git commit failed: ${result.result}`);
      }
    },

    push: async (options: GitOperationOptions): Promise<void> => {
      // If token provided, set credential helper
      if (options.token) {
        const credentialCommand = `git config credential.helper '!f() { echo "username=${options.username || 'x-access-token'}"; echo "password=${options.token}"; }; f'`;
        await this.executeCommand({
          command: credentialCommand,
          workdir: options.workdir,
          timeout: 30,
        });
      }

      // Get current branch name if not provided
      let branchName = options.branch;
      if (!branchName) {
        const branchResult = await this.executeCommand({
          command: 'git rev-parse --abbrev-ref HEAD',
          workdir: options.workdir,
          timeout: 30,
        });
        if (branchResult.exitCode === 0) {
          branchName = branchResult.result.trim();
        }
      }

      // Build push command - always use --set-upstream to handle new branches
      let command = 'git push';
      if (options.force) {
        command += ' --force';
      }
      // Always use -u (--set-upstream) to ensure branch tracking is set up
      if (branchName) {
        command += ` -u origin ${branchName}`;
      }

      logger.debug("[E2B] Executing git push", {
        sandboxId: this.id,
        command,
        branch: branchName,
      });

      const result = await this.executeCommand({
        command,
        workdir: options.workdir,
        timeout: 120,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Git push failed: ${result.result}`);
      }
    },

    pull: async (options: GitOperationOptions): Promise<void> => {
      // If token provided, set credential helper
      if (options.token) {
        const credentialCommand = `git config credential.helper '!f() { echo "username=${options.username || 'x-access-token'}"; echo "password=${options.token}"; }; f'`;
        await this.executeCommand({
          command: credentialCommand,
          workdir: options.workdir,
          timeout: 30,
        });
      }

      const result = await this.executeCommand({
        command: 'git pull',
        workdir: options.workdir,
        timeout: 120,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Git pull failed: ${result.result}`);
      }
    },

    createBranch: async (workdir: string, branchName: string): Promise<void> => {
      const result = await this.executeCommand({
        command: `git checkout -b ${branchName}`,
        workdir,
        timeout: 30,
      });

      if (result.exitCode !== 0 && !result.result.includes('already exists')) {
        throw new Error(`Git create branch failed: ${result.result}`);
      }
    },

    status: async (workdir: string): Promise<string> => {
      const result = await this.executeCommand({
        command: 'git status --porcelain',
        workdir,
        timeout: 30,
      });

      return result.result;
    },
  };

  async start(): Promise<void> {
    // E2B sandboxes are always running once created
    this._state = SandboxState.STARTED;
  }

  async stop(): Promise<void> {
    await this.sandbox.kill();
    this._state = SandboxState.STOPPED;
  }

  getNative<T>(): T {
    return this.sandbox as unknown as T;
  }
}


/**
 * E2B Sandbox Provider
 */
export class E2BSandboxProvider implements ISandboxProvider {
  private SandboxClass: E2BSandboxClass | null = null;
  private apiKeys: string[] = [];
  private currentKeyIndex: number = 0;
  private defaultTemplate: string;
  /** Reserved for future E2B custom domain support */
  private _domain?: string;

  readonly name = 'e2b';

  constructor(config?: {
    apiKey?: string;
    defaultTemplate?: string;
    domain?: string;
  }) {
    // Support multiple comma-separated keys for round-robin
    const keyString = config?.apiKey || process.env.E2B_API_KEY || '';
    this.apiKeys = keyString.split(',').map(k => k.trim()).filter(k => k.length > 0);

    // Use E2B_TEMPLATE env var, then config, then 'base' as default
    this.defaultTemplate = process.env.E2B_TEMPLATE || config?.defaultTemplate || 'base';
    this._domain = config?.domain; // Reserved for future use

    if (this.apiKeys.length === 0) {
      logger.warn("[E2B] No API key provided. Set E2B_API_KEY environment variable.");
    }

    logger.debug("[E2B] Provider initialized", {
      defaultTemplate: this.defaultTemplate,
      keyCount: this.apiKeys.length,
      hasCustomApiKey: !!config?.apiKey,
    });
  }

  /**
   * Get next API key using round-robin rotation
   */
  private getNextApiKey(): string {
    if (this.apiKeys.length === 0) {
      throw new Error("No E2B API keys available");
    }

    const key = this.apiKeys[this.currentKeyIndex];
    const usedIndex = this.currentKeyIndex;

    // Advance to next key (wrap around)
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;

    if (this.apiKeys.length > 1) {
      logger.debug("[E2B] Round-robin key selection", {
        keyIndex: usedIndex,
        nextKeyIndex: this.currentKeyIndex,
        totalKeys: this.apiKeys.length,
      });
    }

    return key;
  }

  /**
   * Get the configured domain (reserved for future use)
   */
  get domain(): string | undefined {
    return this._domain;
  }

  /**
   * Dynamically import E2B SDK
   * Note: e2b package is optional - only required if using E2B provider
   */
  private async getSandboxClass(): Promise<E2BSandboxClass> {
    if (this.SandboxClass) {
      return this.SandboxClass;
    }

    try {
      // Try to import the e2b package dynamically
      // This allows the code to work even if e2b is not installed
      // @ts-ignore - e2b is an optional dependency
      const e2b = await import('e2b');
      this.SandboxClass = e2b.Sandbox as unknown as E2BSandboxClass;
      return this.SandboxClass;
    } catch (error) {
      logger.error("[E2B] Failed to import e2b package. Make sure it's installed: npm install e2b", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("E2B SDK not installed. Run: npm install e2b");
    }
  }

  async create(options?: CreateSandboxOptions): Promise<ISandbox> {
    const Sandbox = await this.getSandboxClass();
    const template = options?.template || this.defaultTemplate;

    // Check if we should use default template (no template specified or 'base')
    // E2B's default template is accessed by calling Sandbox.create() without template argument
    const useDefaultTemplate = !template || template === 'base' || template === 'default';

    // E2B sandbox lifetime timeout (how long sandbox stays alive)
    // Default is 5 minutes, we set to 1 hour (max for Hobby users)
    // Pro users can set up to 24 hours (86_400_000 ms)
    const sandboxLifetimeMs = 3600000; // 1 hour = 3,600,000 ms

    // Get API key using round-robin if multiple keys configured
    const apiKeyToUse = this.getNextApiKey();

    logger.debug("[E2B] Creating sandbox", {
      template: useDefaultTemplate ? '(default)' : template,
      timeout: options?.timeout,
      sandboxLifetimeMs,
      keyIndex: (this.currentKeyIndex - 1 + this.apiKeys.length) % this.apiKeys.length,
    });

    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      // Check for cancellation before each attempt
      if (options?.config && await isRunCancelled(options.config)) {
        throw new Error("Run cancelled");
      }
      try {
        let sandbox: E2BSandbox;

        const createOpts = {
          apiKey: apiKeyToUse,
          // timeoutMs is the sandbox lifetime (how long it stays alive)
          // E2B SDK uses milliseconds for this parameter
          // Max: 24h (86_400_000ms) for Pro, 1h (3_600_000ms) for Hobby
          timeoutMs: sandboxLifetimeMs,
          envs: options?.envs,
          metadata: options?.metadata,
        };

        if (useDefaultTemplate) {
          // Use E2B's default base sandbox template
          sandbox = await Sandbox.create(createOpts);
        } else {
          // Use custom template
          sandbox = await Sandbox.create(template, createOpts);
        }

        logger.debug("[E2B] Sandbox created", {
          sandboxId: sandbox.sandboxId,
          durationMs: Date.now() - startTime,
        });

        return new E2BSandboxWrapper(sandbox);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error("[E2B] Failed to create sandbox", {
          attempt: attempt + 1,
          error: lastError.message,
        });

        if (attempt < 2) {
          await sleep(3000);
        }
      }
    }

    throw lastError ?? new Error("Failed to create E2B sandbox after 3 attempts");
  }

  async get(sandboxId: string): Promise<ISandbox> {
    const Sandbox = await this.getSandboxClass();

    logger.debug("[E2B] Connecting to sandbox", { sandboxId });

    const startTime = Date.now();
    let lastError: Error | undefined;

    // Try each API key until one works
    for (let i = 0; i < this.apiKeys.length; i++) {
      const apiKey = this.apiKeys[i];
      try {
        const sandbox = await Sandbox.connect(sandboxId, {
          apiKey,
        });

        logger.debug("[E2B] Connected to sandbox", {
          sandboxId,
          durationMs: Date.now() - startTime,
          keyIndex: i,
        });

        const wrapper = new E2BSandboxWrapper(sandbox);

        // Extend timeout on reconnect to ensure sandbox stays alive
        // This is important for long-running tasks
        try {
          await wrapper.extendTimeout(3600000); // 1 hour
        } catch (e) {
          logger.warn("[E2B] Failed to extend timeout on reconnect", {
            sandboxId,
            error: e instanceof Error ? e.message : String(e),
          });
        }

        return wrapper;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue trying other keys
        if (this.apiKeys.length > 1) {
          logger.debug("[E2B] Failed to connect with key, trying next", {
            sandboxId,
            keyIndex: i,
            error: lastError.message,
          });
        }
      }
    }

    throw lastError ?? new Error(`Failed to connect to sandbox: ${sandboxId}`);
  }

  async stop(sandboxId: string): Promise<void> {
    // E2B doesn't have a stop concept - sandboxes are either running or killed
    logger.debug("[E2B] Stop called - will kill sandbox", { sandboxId });
    await this.delete(sandboxId);
  }

  async delete(sandboxId: string): Promise<boolean> {
    const Sandbox = await this.getSandboxClass();

    logger.debug("[E2B] Killing sandbox", { sandboxId });

    // Try each API key until one works
    for (let i = 0; i < this.apiKeys.length; i++) {
      const apiKey = this.apiKeys[i];
      try {
        const result = await Sandbox.kill(sandboxId, {
          apiKey,
        });

        logger.debug("[E2B] Sandbox killed", { sandboxId, result, keyIndex: i });
        return result;
      } catch (error) {
        // Continue trying other keys
        if (this.apiKeys.length > 1) {
          logger.debug("[E2B] Failed to kill with key, trying next", {
            sandboxId,
            keyIndex: i,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.error("[E2B] Failed to kill sandbox with any key", { sandboxId });
    return false;
  }

  async list(): Promise<SandboxInfo[]> {
    const Sandbox = await this.getSandboxClass();

    logger.debug("[E2B] Listing sandboxes");

    const allSandboxes: SandboxInfo[] = [];
    const seenIds = new Set<string>();

    // List from all API keys and deduplicate
    for (let i = 0; i < this.apiKeys.length; i++) {
      const apiKey = this.apiKeys[i];
      try {
        const sandboxes = await Sandbox.list({
          apiKey,
        });

        for (const s of sandboxes) {
          if (!seenIds.has(s.sandboxId)) {
            seenIds.add(s.sandboxId);
            allSandboxes.push({
              id: s.sandboxId,
              state: SandboxState.STARTED, // E2B only returns running sandboxes
              template: s.templateId,
              createdAt: s.startedAt ? new Date(s.startedAt) : undefined,
              metadata: s.metadata,
            });
          }
        }
      } catch (error) {
        logger.warn("[E2B] Failed to list sandboxes with key", {
          keyIndex: i,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return allSandboxes;
  }
}

/**
 * Singleton instance
 */
let e2bProviderInstance: E2BSandboxProvider | null = null;

/**
 * Get or create the E2B provider instance
 */
export function getE2BProvider(config?: {
  apiKey?: string;
  defaultTemplate?: string;
  domain?: string;
}): E2BSandboxProvider {
  if (!e2bProviderInstance) {
    e2bProviderInstance = new E2BSandboxProvider(config);
  }
  return e2bProviderInstance;
}
