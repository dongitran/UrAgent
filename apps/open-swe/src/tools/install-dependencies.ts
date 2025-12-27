import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { getSandboxErrorFields } from "../utils/sandbox-error-fields.js";
import { createLogger, LogLevel } from "../utils/logger.js";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import { createInstallDependenciesToolFields } from "@openswe/shared/open-swe/tools";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxSessionOrThrow } from "./utils/get-sandbox-id.js";
import { createShellExecutor } from "../utils/shell-executor/index.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { join, isAbsolute } from "path";

const logger = createLogger(LogLevel.DEBUG, "InstallDependenciesTool");

const DEFAULT_ENV = {
  // Prevents corepack from showing a y/n download prompt which causes the command to hang
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

export function createInstallDependenciesTool(
  state: Pick<GraphState, "sandboxSessionId" | "targetRepository">,
  config: GraphConfig,
) {
  const installDependenciesTool = tool(
    async (input): Promise<{ result: string; status: "success" | "error" }> => {
      try {
        const repoRoot = getRepoAbsolutePath(state.targetRepository);
        const command = input.command.join(" ");

        let workdir = repoRoot;
        if (input.workdir) {
          workdir = isAbsolute(input.workdir)
            ? input.workdir
            : join(repoRoot, input.workdir);
        }

        const timeout = TIMEOUT_SEC * 2.5;

        logger.info("[DAYTONA] Running install dependencies command", {
          command,
          workdir,
          timeout,
          sandboxSessionId: state.sandboxSessionId,
          isLocalMode: isLocalMode(config),
        });

        // Use unified shell executor
        const executor = createShellExecutor(config);
        const sandbox = isLocalMode(config)
          ? undefined
          : await getSandboxSessionOrThrow(input);

        logger.debug("[DAYTONA] Sandbox retrieved for install dependencies", {
          sandboxId: sandbox?.id,
          sandboxState: sandbox?.state,
          command,
          workdir,
        });

        const startTime = Date.now();
        const response = await executor.executeCommand({
          command,
          workdir: workdir,
          env: DEFAULT_ENV,
          timeout,
          sandbox,
        });
        const duration = Date.now() - startTime;

        logger.debug("[DAYTONA] Install dependencies response received", {
          sandboxId: sandbox?.id,
          command,
          workdir,
          durationMs: duration,
          exitCode: response.exitCode,
          resultLength: response.result?.length ?? 0,
          resultPreview: response.result?.substring(0, 500) ?? "null",
          artifacts: response.artifacts
            ? {
                stdoutLength: response.artifacts.stdout?.length ?? 0,
                stderrLength: response.artifacts.stderr?.length ?? 0,
              }
            : null,
          fullResponseJson: JSON.stringify(response).substring(0, 2000),
        });

        if (response.exitCode !== 0) {
          const errorResult = response.result ?? response.artifacts?.stdout;
          let errorMessage = `Failed to install dependencies. Exit code: ${response.exitCode}\nError: ${errorResult}`;

          if (response.exitCode === -1) {
            logger.error(
              "[DAYTONA] Install dependencies returned exit code -1",
              {
                sandboxId: sandbox?.id,
                sandboxState: sandbox?.state,
                command,
                workdir,
                timeout,
                durationMs: duration,
                fullResponse: JSON.stringify(response),
              },
            );
            errorMessage = `Failed to install dependencies. Exit code: -1 (Daytona sandbox issue - possible causes: sandbox disconnected, command timeout, or resource limits exceeded). Try running the command again or check sandbox status.\nOriginal error: ${errorResult || "No output"}`;
          }

          throw new Error(errorMessage);
        }

        logger.info("[DAYTONA] Install dependencies completed successfully", {
          sandboxId: sandbox?.id,
          command,
          durationMs: duration,
          resultLength: response.result?.length ?? 0,
        });

        return {
          result: response.result,
          status: "success",
        };
      } catch (e) {
        // Unified error handling
        const errorFields = getSandboxErrorFields(e);
        if (errorFields) {
          const errorResult =
            errorFields.result ?? errorFields.artifacts?.stdout;
          logger.error(
            "[DAYTONA] Install dependencies failed with sandbox error",
            {
              sandboxSessionId: state.sandboxSessionId,
              exitCode: errorFields.exitCode,
              errorResult: errorResult?.substring(0, 1000),
              fullErrorFields: JSON.stringify(errorFields).substring(0, 2000),
            },
          );
          throw new Error(
            `Failed to install dependencies. Exit code: ${errorFields.exitCode}\nError: ${errorResult}`,
          );
        }

        logger.error("[DAYTONA] Install dependencies threw exception", {
          sandboxSessionId: state.sandboxSessionId,
          error:
            e instanceof Error
              ? {
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                }
              : e,
        });

        throw e;
      }
    },
    createInstallDependenciesToolFields(state.targetRepository),
  );

  return installDependenciesTool;
}
