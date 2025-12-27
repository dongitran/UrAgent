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
import { getSandboxSessionOrThrow } from "../../tools/utils/get-sandbox-id.js";

const logger = createLogger(LogLevel.DEBUG, "ShellExecutor");

const DEFAULT_ENV = {
  // Prevents corepack from showing a y/n download prompt which causes the command to hang
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

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
      return this.executeSandbox(
        commandString,
        workdir,
        environment,
        timeout,
        sandbox,
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
   * Execute command in sandbox
   */
  private async executeSandbox(
    command: string,
    workdir?: string,
    env?: Record<string, string>,
    timeout?: number,
    sandbox?: Sandbox,
    sandboxSessionId?: string,
  ): Promise<LocalExecuteResponse> {
    const sandbox_ =
      sandbox ??
      (await getSandboxSessionOrThrow({
        xSandboxSessionId: sandboxSessionId,
      }));

    logger.debug("[DAYTONA] Executing command in sandbox", {
      sandboxId: sandbox_.id,
      sandboxState: sandbox_.state,
      command: command.length > 500 ? command.substring(0, 500) + "..." : command,
      workdir,
      timeout,
      envKeys: env ? Object.keys(env) : [],
      timestamp: new Date().toISOString(),
    });

    const startTime = Date.now();
    try {
      const response = await sandbox_.process.executeCommand(
        command,
        workdir,
        env,
        timeout,
      );
      const duration = Date.now() - startTime;

      logger.debug("[DAYTONA] Command execution completed", {
        sandboxId: sandbox_.id,
        command: command.length > 200 ? command.substring(0, 200) + "..." : command,
        workdir,
        durationMs: duration,
        exitCode: response.exitCode,
        resultLength: response.result?.length ?? 0,
        resultPreview: response.result?.substring(0, 500) ?? "null",
        artifacts: response.artifacts ? {
          stdoutLength: response.artifacts.stdout?.length ?? 0,
          stderrLength: (response.artifacts as { stdout?: string; stderr?: string }).stderr?.length ?? 0,
          stdoutPreview: response.artifacts.stdout?.substring(0, 300) ?? "null",
          stderrPreview: (response.artifacts as { stdout?: string; stderr?: string }).stderr?.substring(0, 300) ?? "null",
        } : null,
        fullResponse: JSON.stringify(response).substring(0, 1000),
      });

      if (response.exitCode === -1) {
        logger.error("[DAYTONA] Command returned exit code -1 (sandbox issue)", {
          sandboxId: sandbox_.id,
          sandboxState: sandbox_.state,
          command: command.length > 500 ? command.substring(0, 500) + "..." : command,
          workdir,
          timeout,
          durationMs: duration,
          fullResponse: JSON.stringify(response),
        });
      }

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error("[DAYTONA] Command execution threw exception", {
        sandboxId: sandbox_.id,
        sandboxState: sandbox_.state,
        command: command.length > 500 ? command.substring(0, 500) + "..." : command,
        workdir,
        timeout,
        durationMs: duration,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : error,
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
