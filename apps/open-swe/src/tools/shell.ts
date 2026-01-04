import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { getSandboxErrorFields } from "../utils/sandbox-error-fields.js";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import { createShellToolFields } from "@openswe/shared/open-swe/tools";
import { createShellExecutor } from "../utils/shell-executor/index.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { join, isAbsolute } from "path";

const DEFAULT_ENV = {
  // Prevents corepack from showing a y/n download prompt which causes the command to hang
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

export function createShellTool(
  state: Pick<GraphState, "sandboxSessionId" | "targetRepository"> & { sandboxProviderType?: string },
  config: GraphConfig,
) {
  const shellTool = tool(
    async (input): Promise<{ result: string; status: "success" | "error" }> => {
      try {
        const { command, workdir, timeout } = input;
        const repoRoot = getRepoAbsolutePath(state.targetRepository, undefined, state.sandboxProviderType);

        let resolvedWorkdir = repoRoot;
        if (workdir) {
          resolvedWorkdir = isAbsolute(workdir)
            ? workdir
            : join(repoRoot, workdir);
        }

        const executor = createShellExecutor(config);
        const response = await executor.executeCommand({
          command,
          workdir: resolvedWorkdir,
          timeout: timeout ?? TIMEOUT_SEC,
          env: DEFAULT_ENV,
          sandboxSessionId: state.sandboxSessionId,
        });

        if (response.exitCode !== 0) {
          const errorResult = response.result ?? response.artifacts?.stdout;
          let errorMessage = `Command failed. Exit code: ${response.exitCode}\nResult: ${errorResult}`;

          if (response.exitCode === -1) {
            errorMessage = `Command failed. Exit code: -1 (Daytona sandbox issue - possible causes: sandbox disconnected, command timeout, or resource limits exceeded). Try running the command again or check sandbox status.\nOriginal output: ${errorResult || "No output"}`;
          }

          throw new Error(errorMessage);
        }
        return {
          result: response.result ?? `exit code: ${response.exitCode}`,
          status: "success",
        };
      } catch (error: any) {
        const errorFields = getSandboxErrorFields(error);
        if (errorFields) {
          return {
            result: `Error: ${errorFields.result ?? errorFields.artifacts?.stdout}`,
            status: "error",
          };
        }

        return {
          result: `Error: ${error.message || String(error)}`,
          status: "error",
        };
      }
    },
    createShellToolFields(state.targetRepository, state.sandboxProviderType),
  );

  return shellTool;
}
