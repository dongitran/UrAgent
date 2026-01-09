import { Sandbox } from "@daytonaio/sdk";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import { getLocalShellExecutor } from "./local-shell-executor.js";
import { createLogger, LogLevel } from "../logger.js";
import { ExecuteCommandOptions, LocalExecuteResponse } from "./types.js";
import { getSandboxInstanceOrThrow } from "../../tools/utils/get-sandbox-id.js";
import { ISandbox } from "../sandbox-provider/types.js";
import { isRunCancelled } from "../run-cancellation.js";

const logger = createLogger(LogLevel.DEBUG, "ShellExecutor");

const DEFAULT_ENV = {
  // Prevents corepack from showing a y/n download prompt which causes the command to hang
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

// Retry configuration for Daytona sandbox commands
const SANDBOX_MAX_RETRIES = 5;
const SANDBOX_RETRY_DELAY_MS = 10000; // 10 seconds, exponential: 10s → 20s → 40s → 80s → 160s

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (network, timeout, gateway errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    // Network/timeout errors
    if (message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket') ||
      message.includes('fetch failed') ||
      name.includes('timeout') ||
      name.includes('abort')) {
      return true;
    }

    // Gateway errors (502, 503, 504) - often from CloudFront
    if (message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('gateway') ||
      message.includes('cloudfront')) {
      return true;
    }

    // Rate limit errors
    if (message.includes('429') || message.includes('rate limit')) {
      return true;
    }
  }

  return false;
}

/**
 * Unified shell executor that handles both local and sandbox command execution
 * This eliminates the need for if/else blocks in every tool that runs shell commands
 */
export class ShellExecutor {
  private config?: GraphConfig;

  constructor(config?: GraphConfig) {
    this.config = config;
  }

  /**
   * Execute a command either locally or in the sandbox based on the current mode
   */
  async executeCommand(
    options: ExecuteCommandOptions,
  ): Promise<LocalExecuteResponse> {
    const {
      command,
      workdir,
      env = {},
      timeout = TIMEOUT_SEC,
      sandbox,
      sandboxInstance,
      sandboxSessionId,
    } = options;

    const commandString = Array.isArray(command) ? command.join(" ") : command;
    const environment = { ...DEFAULT_ENV, ...env };

    logger.info("Executing command", {
      command: commandString,
      workdir,
      localMode: isLocalMode(this.config),
    });

    if (isLocalMode(this.config)) {
      return this.executeLocal(commandString, workdir, environment, timeout);
    } else {
      // Prefer sandboxInstance (new provider abstraction) over sandbox (legacy Daytona)
      return this.executeSandbox(
        commandString,
        workdir,
        environment,
        timeout,
        sandbox,
        sandboxInstance,
        sandboxSessionId,
      );
    }
  }

  /**
   * Execute command locally using LocalShellExecutor
   */
  private async executeLocal(
    command: string,
    workdir?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<LocalExecuteResponse> {
    const executor = getLocalShellExecutor(getLocalWorkingDirectory());
    const localWorkdir = workdir || getLocalWorkingDirectory();

    return await executor.executeCommand(command, {
      workdir: localWorkdir,
      env,
      timeout,
      localMode: true,
    });
  }

  /**
   * Execute command in sandbox with retry logic for transient errors
   * Supports both legacy Daytona Sandbox and new ISandbox provider abstraction
   */
  private async executeSandbox(
    command: string,
    workdir?: string,
    env?: Record<string, string>,
    timeout?: number,
    sandbox?: Sandbox,
    sandboxInstance?: ISandbox,
    sandboxSessionId?: string,
  ): Promise<LocalExecuteResponse> {
    // If sandboxInstance (new provider abstraction) is provided, use it
    if (sandboxInstance) {
      return this.executeSandboxWithProvider(
        sandboxInstance,
        command,
        workdir,
        env,
        timeout,
      );
    }

    // If legacy Daytona sandbox is provided, use it
    if (sandbox) {
      return this.executeLegacyDaytonaSandbox(
        sandbox,
        command,
        workdir,
        env,
        timeout,
      );
    }

    // Otherwise, use provider abstraction to get sandbox
    const sandboxInstance_ = await getSandboxInstanceOrThrow({
      xSandboxSessionId: sandboxSessionId,
    });

    return this.executeSandboxWithProvider(
      sandboxInstance_,
      command,
      workdir,
      env,
      timeout,
    );
  }

  /**
   * Execute command using legacy Daytona Sandbox (for backward compatibility)
   * @deprecated Use executeSandboxWithProvider instead
   */
  private async executeLegacyDaytonaSandbox(
    sandbox: Sandbox,
    command: string,
    workdir?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<LocalExecuteResponse> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < SANDBOX_MAX_RETRIES; attempt++) {
      // Check for cancellation before each retry attempt
      if (this.config && await isRunCancelled(this.config)) {
        throw new Error("Run cancelled");
      }

      logger.debug("[DAYTONA] Executing command in sandbox", {
        sandboxId: sandbox.id,
        sandboxState: sandbox.state,
        command:
          command.length > 500 ? command.substring(0, 500) + "..." : command,
        workdir,
        timeout,
        envKeys: env ? Object.keys(env) : [],
        attempt: attempt + 1,
        maxRetries: SANDBOX_MAX_RETRIES,
        timestamp: new Date().toISOString(),
      });

      const startTime = Date.now();
      try {
        const response = await sandbox.process.executeCommand(
          command,
          workdir,
          env,
          timeout,
        );
        const duration = Date.now() - startTime;

        logger.debug("[DAYTONA] Command execution completed", {
          sandboxId: sandbox.id,
          command:
            command.length > 200 ? command.substring(0, 200) + "..." : command,
          workdir,
          durationMs: duration,
          exitCode: response.exitCode,
          resultLength: response.result?.length ?? 0,
          resultPreview: response.result?.substring(0, 500) ?? "null",
          attempt: attempt + 1,
          artifacts: response.artifacts
            ? {
              stdoutLength: response.artifacts.stdout?.length ?? 0,
              stderrLength:
                (response.artifacts as { stdout?: string; stderr?: string })
                  .stderr?.length ?? 0,
              stdoutPreview:
                response.artifacts.stdout?.substring(0, 300) ?? "null",
              stderrPreview:
                (
                  response.artifacts as { stdout?: string; stderr?: string }
                ).stderr?.substring(0, 300) ?? "null",
            }
            : null,
          fullResponse: JSON.stringify(response).substring(0, 1000),
        });

        if (response.exitCode === -1) {
          logger.error(
            "[DAYTONA] Command returned exit code -1 (sandbox issue)",
            {
              sandboxId: sandbox.id,
              sandboxState: sandbox.state,
              command:
                command.length > 500
                  ? command.substring(0, 500) + "..."
                  : command,
              workdir,
              timeout,
              durationMs: duration,
              attempt: attempt + 1,
              fullResponse: JSON.stringify(response),
            },
          );
        }

        return response;
      } catch (error) {
        const duration = Date.now() - startTime;
        lastError = error instanceof Error ? error : new Error(String(error));

        const shouldRetry = isRetryableError(error) && attempt < SANDBOX_MAX_RETRIES - 1;

        if (shouldRetry) {
          const delay = SANDBOX_RETRY_DELAY_MS * Math.pow(2, attempt); // Exponential backoff: 10s, 20s, 40s, 80s, 160s
          logger.warn("[DAYTONA] Command execution failed, will retry", {
            sandboxId: sandbox.id,
            sandboxState: sandbox.state,
            command:
              command.length > 500 ? command.substring(0, 500) + "..." : command,
            workdir,
            timeout,
            durationMs: duration,
            attempt: attempt + 1,
            maxRetries: SANDBOX_MAX_RETRIES,
            retryDelayMs: delay,
            error: {
              name: lastError.name,
              message: lastError.message,
            },
          });
          await sleep(delay);
          continue;
        }

        logger.error("[DAYTONA] Command execution threw exception", {
          sandboxId: sandbox.id,
          sandboxState: sandbox.state,
          command:
            command.length > 500 ? command.substring(0, 500) + "..." : command,
          workdir,
          timeout,
          durationMs: duration,
          attempt: attempt + 1,
          maxRetries: SANDBOX_MAX_RETRIES,
          isRetryable: isRetryableError(error),
          error:
            error instanceof Error
              ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
              : error,
        });
        throw error;
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new Error("Unknown error in executeLegacyDaytonaSandbox");
  }

  /**
   * Execute command using the new provider abstraction (ISandbox)
   * This method has built-in retry logic in the provider
   */
  private async executeSandboxWithProvider(
    sandboxInstance: ISandbox,
    command: string,
    workdir?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<LocalExecuteResponse> {
    logger.debug("[SANDBOX] Executing command via provider", {
      sandboxId: sandboxInstance.id,
      sandboxState: sandboxInstance.state,
      command: command.length > 500 ? command.substring(0, 500) + "..." : command,
      workdir,
      timeout,
      envKeys: env ? Object.keys(env) : [],
    });

    const startTime = Date.now();
    try {
      const result = await sandboxInstance.executeCommand({
        command,
        workdir,
        env,
        timeout,
        config: this.config,
      });

      const duration = Date.now() - startTime;
      logger.debug("[SANDBOX] Command execution completed via provider", {
        sandboxId: sandboxInstance.id,
        command: command.length > 200 ? command.substring(0, 200) + "..." : command,
        durationMs: duration,
        exitCode: result.exitCode,
        resultLength: result.result?.length ?? 0,
      });

      return {
        exitCode: result.exitCode,
        result: result.result,
        artifacts: result.artifacts,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error("[SANDBOX] Command execution failed via provider", {
        sandboxId: sandboxInstance.id,
        command: command.length > 500 ? command.substring(0, 500) + "..." : command,
        durationMs: duration,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
      });
      throw error;
    }
  }

  /**
   * Check if we're in local mode
   */
  checkLocalMode(): boolean {
    return isLocalMode(this.config);
  }

  /**
   * Get the appropriate working directory for the current mode
   */
  getWorkingDirectory(): string {
    if (isLocalMode(this.config)) {
      return getLocalWorkingDirectory();
    }
    // For sandbox mode, this would need to be provided by the caller
    // since it depends on the specific sandbox context
    throw new Error(
      "Working directory for sandbox mode must be provided explicitly",
    );
  }
}

/**
 * Factory function to create a ShellExecutor instance
 */
export function createShellExecutor(config?: GraphConfig): ShellExecutor {
  return new ShellExecutor(config);
}

/**
 * Convenience function for one-off command execution
 */
export async function executeCommand(
  config: GraphConfig,
  options: ExecuteCommandOptions,
): Promise<LocalExecuteResponse> {
  const executor = createShellExecutor(config);
  return await executor.executeCommand(options);
}
