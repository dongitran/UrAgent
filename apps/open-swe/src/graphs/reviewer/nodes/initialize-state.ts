import {
  ReviewerGraphState,
  ReviewerGraphUpdate,
} from "@openswe/shared/open-swe/reviewer/types";
import { getSandboxInstanceWithErrorHandling } from "../../../utils/sandbox.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";
import { createReviewStartedToolFields } from "@openswe/shared/open-swe/tools";
import { getSandboxErrorFields } from "../../../utils/sandbox-error-fields.js";
import { ISandbox } from "../../../utils/sandbox-provider/types.js";
import { createShellExecutor } from "../../../utils/shell-executor/index.js";

const logger = createLogger(LogLevel.INFO, "InitializeStateNode");

function createReviewStartedMessage() {
  const reviewStartedTool = createReviewStartedToolFields();
  const toolCallId = uuidv4();
  const reviewStartedToolCall = {
    id: toolCallId,
    name: reviewStartedTool.name,
    args: {
      review_started: true,
    },
  };

  return [
    new AIMessage({
      id: uuidv4(),
      content: "",
      additional_kwargs: {
        hidden: true,
      },
      tool_calls: [reviewStartedToolCall],
    }),
    new ToolMessage({
      id: uuidv4(),
      tool_call_id: toolCallId,
      content: "Review started",
      additional_kwargs: {
        hidden: true,
      },
    }),
  ];
}

async function getChangedFiles(
  sandboxInstance: ISandbox,
  baseBranchName: string,
  repoRoot: string,
  config: GraphConfig,
): Promise<string> {
  try {
    const executor = createShellExecutor(config);

    // Git diff with local base branch (always exists because providers clone base branch first)
    const changedFilesRes = await executor.executeCommand({
      command: `git diff ${baseBranchName} --name-only`,
      workdir: repoRoot,
      timeout: 30,
      sandboxInstance,
    });

    if (changedFilesRes.exitCode !== 0) {
      logger.error(`Failed to get changed files: ${changedFilesRes.result}`);
      return "Failed to get changed files.";
    }
    return changedFilesRes.result.trim();
  } catch (e) {
    const errorFields = getSandboxErrorFields(e);
    logger.error("Failed to get changed files.", {
      ...(errorFields ? { errorFields } : { e }),
    });
    return "Failed to get changed files.";
  }
}

async function getBaseBranchName(
  sandboxInstance: ISandbox,
  repoRoot: string,
  config: GraphConfig,
): Promise<string> {
  try {
    const executor = createShellExecutor(config);
    const baseBranchNameRes = await executor.executeCommand({
      command: "git config init.defaultBranch",
      workdir: repoRoot,
      timeout: 30,
      sandboxInstance,
    });

    if (baseBranchNameRes.exitCode !== 0) {
      logger.error("Failed to get base branch name", {
        result: baseBranchNameRes.result,
      });
      return "";
    }
    return baseBranchNameRes.result.trim();
  } catch (e) {
    const errorFields = getSandboxErrorFields(e);
    logger.error("Failed to get base branch name.", {
      ...(errorFields ? { errorFields } : { e }),
    });
    return "";
  }
}

export async function initializeState(
  state: ReviewerGraphState,
  config: GraphConfig,
): Promise<ReviewerGraphUpdate> {
  logger.info("Initializing state for reviewer");

  // get the base branch name, then get the changed files
  const { sandboxInstance, codebaseTree, dependenciesInstalled, sandboxProviderType } =
    await getSandboxInstanceWithErrorHandling(
      state.sandboxSessionId,
      state.targetRepository,
      state.branchName,
      config,
    );

  // Get repo root AFTER sandbox is created to use correct provider type
  const repoRoot = getRepoAbsolutePath(state.targetRepository, config, sandboxInstance.providerType);

  let baseBranchName = state.targetRepository.branch;
  if (!baseBranchName) {
    baseBranchName = await getBaseBranchName(sandboxInstance, repoRoot, config);
  }
  const changedFiles = baseBranchName
    ? await getChangedFiles(sandboxInstance, baseBranchName, repoRoot, config)
    : "";

  logger.info("Finished getting state for reviewer");

  return {
    baseBranchName,
    changedFiles,
    messages: createReviewStartedMessage(),
    reviewerMessages: [], // Reset reviewer messages for each new review cycle
    sandboxSessionId: sandboxInstance.id,
    ...(sandboxProviderType && { sandboxProviderType }),
    ...(codebaseTree ? { codebaseTree } : {}),
    ...(dependenciesInstalled !== null ? { dependenciesInstalled } : {}),
  };
}
