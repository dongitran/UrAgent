/**
 * Daytona Sandbox Provider Implementation
 * 
 * Wraps the Daytona SDK to implement the ISandboxProvider interface
 */

import { Daytona, Sandbox as DaytonaSandbox, SandboxState as DaytonaSandboxState } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "../logger.js";
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
} from "./types.js";

const logger = createLogger(LogLevel.DEBUG, "DaytonaSandboxProvider");

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10000;

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
    const name = error.name.toLowerCase();
    
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket') ||
      message.includes('fetch failed') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('gateway') ||
      message.includes('cloudfront') ||
      name.includes('timeout') ||
      name.includes('abort')
    );
  }
  return false;
}

/**
 * Map Daytona state to unified state
 */
function mapDaytonaState(state: DaytonaSandboxState | string): SandboxState {
  switch (state) {
    case DaytonaSandboxState.STARTED:
    case 'started':
      return SandboxState.STARTED;
    case DaytonaSandboxState.STOPPED:
    case 'stopped':
      return SandboxState.STOPPED;
    case DaytonaSandboxState.ARCHIVED:
    case 'archived':
      return SandboxState.ARCHIVED;
    default:
      return SandboxState.UNKNOWN;
  }
}

/**
 * Daytona Sandbox wrapper implementing ISandbox
 */
export class DaytonaSandboxWrapper implements ISandbox {
  private sandbox: DaytonaSandbox;
  
  constructor(sandbox: DaytonaSandbox) {
    this.sandbox = sandbox;
  }
  
  get id(): string {
    return this.sandbox.id;
  }
  
  get state(): SandboxState {
    return mapDaytonaState(this.sandbox.state || 'unknown');
  }
  
  async executeCommand(options: ExecuteCommandOptions): Promise<ExecuteCommandResult> {
    const { command, workdir = '/home/daytona', env = {}, timeout = 30 } = options;
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        logger.debug("[DAYTONA] Executing command", {
          sandboxId: this.id,
          command: command.substring(0, 200),
          workdir,
          attempt: attempt + 1,
        });
        
        const startTime = Date.now();
        const response = await this.sandbox.process.executeCommand(
          command,
          workdir,
          Object.keys(env).length > 0 ? env : undefined,
          timeout,
        );
        
        logger.debug("[DAYTONA] Command completed", {
          sandboxId: this.id,
          durationMs: Date.now() - startTime,
          exitCode: response.exitCode,
        });
        
        return {
          exitCode: response.exitCode,
          result: response.result,
          artifacts: response.artifacts ? {
            stdout: response.artifacts.stdout || '',
            stderr: (response.artifacts as any).stderr,
          } : undefined,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.warn("[DAYTONA] Command failed, retrying...", {
            sandboxId: this.id,
            attempt: attempt + 1,
            retryDelayMs: delay,
            error: lastError.message,
          });
          await sleep(delay);
          continue;
        }
        
        throw error;
      }
    }
    
    throw lastError ?? new Error("Unknown error in executeCommand");
  }
  
  async readFile(path: string): Promise<string> {
    const result = await this.executeCommand({
      command: `cat "${path}"`,
      timeout: 30,
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.result}`);
    }
    
    return result.result;
  }
  
  async writeFile(path: string, content: string): Promise<void> {
    // Use heredoc to write file content safely
    const delimiter = `EOF_${Date.now()}`;
    const command = `cat > "${path}" << '${delimiter}'
${content}
${delimiter}`;
    
    const result = await this.executeCommand({
      command,
      timeout: 30,
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file ${path}: ${result.result}`);
    }
  }
  
  async exists(path: string): Promise<boolean> {
    const result = await this.executeCommand({
      command: `test -e "${path}" && echo "exists" || echo "not_exists"`,
      timeout: 10,
    });
    
    return result.result.trim() === 'exists';
  }
  
  async mkdir(path: string): Promise<void> {
    const result = await this.executeCommand({
      command: `mkdir -p "${path}"`,
      timeout: 10,
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create directory ${path}: ${result.result}`);
    }
  }
  
  async remove(path: string): Promise<void> {
    const result = await this.executeCommand({
      command: `rm -rf "${path}"`,
      timeout: 30,
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Failed to remove ${path}: ${result.result}`);
    }
  }
  
  git = {
    clone: async (options: GitCloneOptions): Promise<void> => {
      logger.debug("[DAYTONA] Git clone", {
        sandboxId: this.id,
        url: options.url.replace(/\/\/.*@/, '//***@'),
        targetDir: options.targetDir,
        branch: options.branch,
        baseBranch: options.baseBranch,
      });
      
      try {
        // Try to clone the specified branch first
        await this.sandbox.git.clone(
          options.url,
          options.targetDir,
          options.branch,
          options.commit,
          options.username || 'x-access-token',
          options.token,
        );
        logger.info("[DAYTONA] Git clone successful", {
          sandboxId: this.id,
          branch: options.branch,
        });
      } catch (cloneError) {
        const errorMessage = cloneError instanceof Error ? cloneError.message : String(cloneError);
        
        // Check if error is because branch doesn't exist on remote
        if (errorMessage.includes("couldn't find remote ref") || 
            errorMessage.includes("Remote branch") ||
            errorMessage.includes("not found")) {
          logger.warn("[DAYTONA] Branch not found on remote, cloning base branch instead", {
            sandboxId: this.id,
            requestedBranch: options.branch,
            baseBranch: options.baseBranch,
            error: errorMessage,
          });
          
          // Clone the base branch (or default branch) instead
          const branchToClone = options.baseBranch || 'main';
          await this.sandbox.git.clone(
            options.url,
            options.targetDir,
            branchToClone,
            options.commit,
            options.username || 'x-access-token',
            options.token,
          );
          
          logger.info("[DAYTONA] Cloned base branch successfully", {
            sandboxId: this.id,
            branch: branchToClone,
          });
          
          // Create the new branch locally if it's different from base
          if (options.branch && options.branch !== branchToClone) {
            logger.info("[DAYTONA] Creating new branch from base", {
              sandboxId: this.id,
              newBranch: options.branch,
              baseBranch: branchToClone,
            });
            
            await this.sandbox.git.createBranch(options.targetDir, options.branch);
            
            logger.info("[DAYTONA] New branch created", {
              sandboxId: this.id,
              branch: options.branch,
            });
          }
        } else {
          // Re-throw other errors
          throw cloneError;
        }
      }
    },
    
    add: async (workdir: string, files: string[]): Promise<void> => {
      await this.sandbox.git.add(workdir, files);
    },
    
    commit: async (options: GitCommitOptions): Promise<void> => {
      await this.sandbox.git.commit(
        options.workdir,
        options.message,
        options.authorName,
        options.authorEmail,
      );
    },
    
    push: async (options: GitOperationOptions): Promise<void> => {
      await this.sandbox.git.push(
        options.workdir,
        options.username || 'x-access-token',
        options.token,
      );
    },
    
    pull: async (options: GitOperationOptions): Promise<void> => {
      await this.sandbox.git.pull(
        options.workdir,
        options.username || 'x-access-token',
        options.token,
      );
    },
    
    createBranch: async (workdir: string, branchName: string): Promise<void> => {
      await this.sandbox.git.createBranch(workdir, branchName);
    },
    
    status: async (workdir: string): Promise<string> => {
      const status = await this.sandbox.git.status(workdir);
      return JSON.stringify(status);
    },
  };
  
  async start(): Promise<void> {
    await this.sandbox.start();
  }
  
  async stop(): Promise<void> {
    // Daytona SDK doesn't have stop on sandbox instance
    // This is handled by the provider
  }
  
  getNative<T>(): T {
    return this.sandbox as unknown as T;
  }
}


/**
 * Daytona Sandbox Provider
 */
export class DaytonaSandboxProvider implements ISandboxProvider {
  private client: Daytona;
  private defaultSnapshot: string;
  private defaultUser: string;
  
  readonly name = 'daytona';
  
  constructor(config?: {
    apiUrl?: string;
    apiKey?: string;
    defaultSnapshot?: string;
    defaultUser?: string;
  }) {
    // If apiKey is provided, set it in environment for Daytona SDK
    // Daytona SDK reads from DAYTONA_API_KEY env var
    if (config?.apiKey) {
      process.env.DAYTONA_API_KEY = config.apiKey;
    }
    if (config?.apiUrl) {
      process.env.DAYTONA_API_URL = config.apiUrl;
    }
    
    this.client = new Daytona();
    this.defaultSnapshot = config?.defaultSnapshot || process.env.DAYTONA_SNAPSHOT_NAME || 'daytona-small';
    this.defaultUser = config?.defaultUser || 'daytona';
    
    logger.debug("[DAYTONA] Provider initialized", {
      defaultSnapshot: this.defaultSnapshot,
      defaultUser: this.defaultUser,
      hasCustomApiKey: !!config?.apiKey,
    });
  }
  
  async create(options?: CreateSandboxOptions): Promise<ISandbox> {
    const createParams = {
      user: options?.user || this.defaultUser,
      snapshot: options?.template || this.defaultSnapshot,
      autoDeleteInterval: options?.autoDeleteInterval || 15,
    };
    
    logger.debug("[DAYTONA] Creating sandbox", { createParams });
    
    const startTime = Date.now();
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sandbox = await this.client.create(createParams, {
          timeout: options?.timeout || 100,
        });
        
        logger.debug("[DAYTONA] Sandbox created", {
          sandboxId: sandbox.id,
          durationMs: Date.now() - startTime,
        });
        
        return new DaytonaSandboxWrapper(sandbox);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error("[DAYTONA] Failed to create sandbox", {
          attempt: attempt + 1,
          error: lastError.message,
        });
        
        if (attempt < 2) {
          await sleep(5000);
        }
      }
    }
    
    throw lastError ?? new Error("Failed to create sandbox after 3 attempts");
  }
  
  async get(sandboxId: string): Promise<ISandbox> {
    logger.debug("[DAYTONA] Getting sandbox", { sandboxId });
    
    const startTime = Date.now();
    const sandbox = await this.client.get(sandboxId);
    
    logger.debug("[DAYTONA] Got sandbox", {
      sandboxId,
      state: sandbox.state,
      durationMs: Date.now() - startTime,
    });
    
    return new DaytonaSandboxWrapper(sandbox);
  }
  
  async stop(sandboxId: string): Promise<void> {
    logger.debug("[DAYTONA] Stopping sandbox", { sandboxId });
    
    const sandbox = await this.client.get(sandboxId);
    
    if (sandbox.state === DaytonaSandboxState.STOPPED || 
        sandbox.state === DaytonaSandboxState.ARCHIVED) {
      logger.debug("[DAYTONA] Sandbox already stopped", { sandboxId });
      return;
    }
    
    if (sandbox.state === 'started') {
      await this.client.stop(sandbox);
      logger.debug("[DAYTONA] Sandbox stopped", { sandboxId });
    }
  }
  
  async delete(sandboxId: string): Promise<boolean> {
    logger.debug("[DAYTONA] Deleting sandbox", { sandboxId });
    
    try {
      const sandbox = await this.client.get(sandboxId);
      await this.client.delete(sandbox);
      logger.debug("[DAYTONA] Sandbox deleted", { sandboxId });
      return true;
    } catch (error) {
      logger.error("[DAYTONA] Failed to delete sandbox", {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  
  async list(): Promise<SandboxInfo[]> {
    // Daytona SDK doesn't have a list method in the current version
    // Return empty array for now
    logger.warn("[DAYTONA] List sandboxes not implemented");
    return [];
  }
  
  /**
   * Get the underlying Daytona client
   */
  getClient(): Daytona {
    return this.client;
  }
}

/**
 * Singleton instance
 */
let daytonaProviderInstance: DaytonaSandboxProvider | null = null;

/**
 * Get or create the Daytona provider instance
 */
export function getDaytonaProvider(config?: {
  apiUrl?: string;
  apiKey?: string;
  defaultSnapshot?: string;
  defaultUser?: string;
}): DaytonaSandboxProvider {
  if (!daytonaProviderInstance) {
    daytonaProviderInstance = new DaytonaSandboxProvider(config);
  }
  return daytonaProviderInstance;
}
