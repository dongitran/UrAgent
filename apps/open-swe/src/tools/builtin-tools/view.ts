import { join, isAbsolute } from "path";
import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxInstanceOrThrow } from "../utils/get-sandbox-id.js";
import { createViewToolFields } from "@openswe/shared/open-swe/tools";
import { handleViewCommandWithInstance } from "./handlers.js";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import { createShellExecutor } from "../../utils/shell-executor/index.js";

const logger = createLogger(LogLevel.INFO, "ViewTool");

export function createViewTool(
  state: Pick<GraphState, "sandboxSessionId" | "targetRepository">,
  config: GraphConfig,
) {
  const viewTool = tool(
    async (input): Promise<{ result: string; status: "success" | "error" }> => {
      try {
        const {
          command,
          path,
          view_range,
          workdir: inputWorkdir,
        } = input as {
          command: string;
          path: string;
          view_range?: [number, number];
          workdir?: string;
        };
        if (command !== "view") {
          throw new Error(`Unknown command: ${command}`);
        }

        const repoRoot = isLocalMode(config)
          ? getLocalWorkingDirectory()
          : getRepoAbsolutePath(state.targetRepository);

        let workDir = repoRoot;
        if (inputWorkdir) {
          workDir = isAbsolute(inputWorkdir)
            ? inputWorkdir
            : join(repoRoot, inputWorkdir);
        }

        // Normalize path: if path already includes the workdir prefix, strip it
        let normalizedPath = path;
        if (inputWorkdir && path.startsWith(inputWorkdir)) {
          // Path already includes workdir, strip it to avoid double-path
          normalizedPath = path.slice(inputWorkdir.length).replace(/^\//, "");
          logger.info("Stripped workdir prefix from path", {
            originalPath: path,
            normalizedPath,
            inputWorkdir,
          });
        }

        logger.info("View command executing", {
          originalPath: path,
          normalizedPath,
          workDir,
          inputWorkdir,
          repoRoot,
        });

        let result: string;
        if (isLocalMode(config)) {
          const executor = createShellExecutor(config);

          // Convert sandbox path to local path - handle both Daytona and E2B paths
          let localPath = normalizedPath;
          if (normalizedPath.startsWith("/home/daytona/project/")) {
            localPath = normalizedPath.replace("/home/daytona/project/", "");
          } else if (normalizedPath.startsWith("/home/daytona/")) {
            localPath = normalizedPath.replace("/home/daytona/", "");
          } else if (normalizedPath.startsWith("/home/user/")) {
            localPath = normalizedPath.replace("/home/user/", "");
          }
          const filePath = join(workDir, localPath);

          const response = await executor.executeCommand({
            command: `cat "${filePath}"`,
            workdir: workDir,
            timeout: TIMEOUT_SEC,
          });

          if (response.exitCode !== 0) {
            throw new Error(`Failed to read file: ${response.result}`);
          }

          result = response.result;
        } else {
          const sandboxInstance = await getSandboxInstanceOrThrow(input);
          result = await handleViewCommandWithInstance(sandboxInstance, config, {
            path: normalizedPath,
            workDir,
            viewRange: view_range as [number, number] | undefined,
          });
        }

        logger.info(`View command executed successfully on ${normalizedPath}`);
        return { result, status: "success" };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`View command failed: ${errorMessage}`);
        return {
          result: `Error: ${errorMessage}`,
          status: "error",
        };
      }
    },
    createViewToolFields(state.targetRepository),
  );

  return viewTool;
}
