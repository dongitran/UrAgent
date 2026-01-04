/**
 * Shell Executor Adapter for Sandbox Provider
 * 
 * This module provides a shell executor that works with the new sandbox provider
 * abstraction layer, maintaining backward compatibility with existing code.
 */

import { GraphConfig } from "@openswe/shared/open-swe/types";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import { getLocalShellExecutor } from "../shell-executor/local-shell-executor.js";
import { createLogger, LogLevel } from "../logger.js";
import { LocalExecuteResponse } from "../shell-executor/types.js";
import { ISandbox } from "./types.js";
import { getSandbox } from "./sandbox-adapter.js";

const logger = createLogger(LogLevel.DEBUG, "ShellExecutorAdapter");

const DEFAULT_ENV = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

export interface ExecuteCommandOptions {
  command: string | string[];
  workdir?: string;
  env?: Record<string, string>;
  timeout?: number;
  sandbox?: ISandbox;
  sandboxSessionId?: string;
}

/**
 * Unified shell executor that works with the sandbox provider abstraction
 */
export class ShellExecutorWithProvider {
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

    logger.debug("Executing command", {
      command: commandString.substring(0, 200),
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
   * Execute command in sandbox using the provider abstraction
   */
  private async executeSandbox(
    command: string,
    workdir?: string,
    env?: Record<string, string>,
    timeout?: number,
    sandbox?: ISandbox,
    sandboxSessionId?: string,
  ): Promise<LocalExecuteResponse> {
    // Get sandbox from provider if not provided
    const sandboxInstance = sandbox ?? (sandboxSessionId ? await getSandbox(sandboxSessionId) : null);
    
    if (!sandboxInstance) {
      throw new Error("No sandbox provided and no sandboxSessionId to fetch one");
    }

    logger.debug("Executing command in sandbox via provider", {
      sandboxId: sandboxInstance.id,
      command: command.substring(0, 200),
      workdir,
      timeout,
    });

    const startTime = Date.now();
    
    try {
      const result = await sandboxInstance.executeCommand({
        command,
        workdir,
        env,
        timeout,
      });

      logger.debug("Command completed via provider", {
        sandboxId: sandboxInstance.id,
        durationMs: Date.now() - startTime,
        exitCode: result.exitCode,
      });

      return {
        exitCode: result.exitCode,
        result: result.result,
        artifacts: result.artifacts,
      };
    } catch (error) {
      logger.error("Command execution failed via provider", {
        sandboxId: sandboxInstance.id,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
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
    throw new Error(
      "Working directory for sandbox mode must be provided explicitly",
    );
  }
}

/**
 * Factory function to create a ShellExecutorWithProvider instance
 */
export function createShellExecutorWithProvider(config?: GraphConfig): ShellExecutorWithProvider {
  return new ShellExecutorWithProvider(config);
}
