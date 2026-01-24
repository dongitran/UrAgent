import { v4 as uuidv4 } from "uuid";
import { isAIMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import {
  createApplyPatchTool,
  createGetURLContentTool,
  createTextEditorTool,
  createShellTool,
  createSearchDocumentForTool,
  createWriteDefaultTsConfigTool,
  createReadImageTool,
} from "../../../tools/index.js";
import { createViewTool } from "../../../tools/builtin-tools/view.js";
import {
  GraphState,
  GraphConfig,
  GraphUpdate,
  TaskPlan,
} from "@openswe/shared/open-swe/types";
import {
  checkoutBranchAndCommitWithInstance,
  getChangedFilesStatusWithInstance,
} from "../../../utils/github/git.js";
import {
  safeSchemaToString,
  safeBadArgsError,
} from "../../../utils/zod-to-string.js";
import { Command, END } from "@langchain/langgraph";
import { isRunCancelled } from "../../../utils/run-cancellation.js";

import { getSandboxInstanceWithErrorHandling, deleteSandbox } from "../../../utils/sandbox.js";
import {
  FAILED_TO_GENERATE_TREE_MESSAGE,
  getCodebaseTree,
} from "../../../utils/tree.js";
import { createInstallDependenciesTool } from "../../../tools/install-dependencies.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { createGrepTool } from "../../../tools/grep.js";
import { getMcpTools } from "../../../utils/mcp-client.js";
import { shouldDiagnoseError } from "../../../utils/tool-message-error.js";
import { getGitHubTokensFromConfig } from "../../../utils/github-tokens.js";
import { processToolCallContent } from "../../../utils/tool-output-processing.js";
import { getActiveTask } from "@openswe/shared/open-swe/tasks";
import { createPullRequestToolCallMessage } from "../../../utils/message/create-pr-message.js";
import { filterUnsafeCommands } from "../../../utils/command-evaluation.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { normalizeToolCallArgs } from "../../../utils/normalize-tool-args.js";
import {
  createReplyToCommentTool,
  createReplyToReviewCommentTool,
  createReplyToReviewTool,
  shouldIncludeReviewCommentTool,
} from "../../../tools/reply-to-review-comment.js";

const logger = createLogger(LogLevel.INFO, "TakeAction");

/**
 * Check if an error is a "Run cancelled" error thrown from sandbox operations
 */
function isRunCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === "Run cancelled";
}

/**
 * Handle Run cancelled by deleting sandbox and returning END command
 */
async function handleRunCancelled(
  sandboxSessionId: string | undefined,
  source: string,
): Promise<Command> {
  logger.warn(`Stopping programmer (${source}) because run was cancelled by user (caught error)`);
  if (sandboxSessionId) {
    try {
      await deleteSandbox(sandboxSessionId);
      logger.info("Sandbox deleted after Run cancelled error", {
        sandboxSessionId,
        source,
      });
    } catch (deleteError) {
      logger.warn("Failed to delete sandbox after Run cancelled error", {
        sandboxSessionId,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
  }
  return new Command({
    goto: END,
    update: {
      sandboxSessionId: undefined,
    },
  });
}

export async function takeAction(
  state: GraphState,
  config: GraphConfig,
): Promise<Command> {
  const lastMessage = state.internalMessages[state.internalMessages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    throw new Error("Last message is not an AI message with tool calls.");
  }

  const applyPatchTool = createApplyPatchTool(state, config);
  const shellTool = createShellTool(state, config);
  const searchTool = createGrepTool(state, config);
  const textEditorTool = createTextEditorTool(state, config);
  const viewTool = createViewTool(state, config);
  const installDependenciesTool = createInstallDependenciesTool(state, config);
  const getURLContentTool = createGetURLContentTool(state);
  const searchDocumentForTool = createSearchDocumentForTool(state, config);
  const mcpTools = await getMcpTools(config);
  const writeDefaultTsConfigTool = createWriteDefaultTsConfigTool(
    state,
    config,
  );
  const readImageTool = createReadImageTool(state, config);

  const higherContextLimitToolNames = [
    ...mcpTools.map((t) => t.name),
    getURLContentTool.name,
    searchDocumentForTool.name,
    writeDefaultTsConfigTool.name,
  ];

  const allTools = [
    shellTool,
    searchTool,
    textEditorTool,
    viewTool,
    installDependenciesTool,
    applyPatchTool,
    getURLContentTool,
    searchDocumentForTool,
    writeDefaultTsConfigTool,
    readImageTool,
    ...(shouldIncludeReviewCommentTool(state, config)
      ? [
        createReplyToReviewCommentTool(state, config),
        createReplyToCommentTool(state, config),
        createReplyToReviewTool(state, config),
      ]
      : []),
    ...mcpTools,
  ];
  const toolsMap = Object.fromEntries(
    allTools.map((tool) => [tool.name, tool]),
  );

  let toolCalls = lastMessage.tool_calls;
  if (!toolCalls?.length) {
    throw new Error("No tool calls found.");
  }

  // Filter out unsafe commands only in local mode
  let modifiedMessage: AIMessage | undefined;
  let wasFiltered = false;
  if (isLocalMode(config)) {
    const filterResult = await filterUnsafeCommands(toolCalls, config);

    if (filterResult.wasFiltered) {
      wasFiltered = true;
      modifiedMessage = new AIMessage({
        ...lastMessage,
        tool_calls: filterResult.filteredToolCalls,
      });
      toolCalls = filterResult.filteredToolCalls;
    }
  }

  const { sandboxInstance, dependenciesInstalled, sandboxProviderType } = await getSandboxInstanceWithErrorHandling(
    state.sandboxSessionId,
    state.targetRepository,
    state.branchName,
    config,
  );

  // Helper function to execute a single tool call
  const executeToolCall = async (toolCall: typeof toolCalls[0]) => {
    const tool = toolsMap[toolCall.name];

    if (!tool) {
      logger.error(`Unknown tool: ${toolCall.name}`);
      const toolMessage = new ToolMessage({
        id: uuidv4(),
        tool_call_id: toolCall.id ?? "",
        content: `Unknown tool: ${toolCall.name}`,
        name: toolCall.name,
        status: "error",
      });
      return { toolMessage, stateUpdates: undefined };
    }

    let result = "";
    let toolCallStatus: "success" | "error" = "success";
    try {
      // Normalize tool args before invoke to handle common AI model mistakes
      // (e.g., using 'pattern' instead of 'query' for grep tool)
      const normalizedArgs = normalizeToolCallArgs(toolCall.name, toolCall.args);
      const toolResult: { result: string; status: "success" | "error" } =
        // @ts-expect-error tool.invoke types are weird here...
        await tool.invoke({
          ...normalizedArgs,
          // Only pass sandbox session ID in sandbox mode, not local mode
          ...(isLocalMode(config) ? {} : { xSandboxSessionId: sandboxInstance.id }),
        });
      if (typeof toolResult === "string") {
        result = toolResult;
        toolCallStatus = "success";
      } else {
        result = toolResult.result;
        toolCallStatus = toolResult.status;
      }

      if (!result) {
        result =
          toolCallStatus === "success"
            ? "Tool call returned no result"
            : "Tool call failed";
      }
    } catch (e) {
      toolCallStatus = "error";
      if (
        e instanceof Error &&
        e.message === "Received tool input did not match expected schema"
      ) {
        logger.error("Received tool input did not match expected schema", {
          toolCall,
          expectedSchema: safeSchemaToString(tool.schema),
        });
        result = safeBadArgsError(tool.schema, toolCall.args, toolCall.name);
      } else {
        logger.error("Failed to call tool", {
          ...(e instanceof Error
            ? { name: e.name, message: e.message, stack: e.stack }
            : { error: e }),
        });
        const errMessage = e instanceof Error ? e.message : "Unknown error";
        result = `FAILED TO CALL TOOL: "${toolCall.name}"\n\n${errMessage}`;
      }
    }

    const { content, stateUpdates, imageDescriptionToCache } = await processToolCallContent(
      toolCall,
      result,
      {
        higherContextLimitToolNames,
        state,
        config,
      },
    );

    const toolMessage = new ToolMessage({
      id: uuidv4(),
      tool_call_id: toolCall.id ?? "",
      content,
      name: toolCall.name,
      status: toolCallStatus,
    });

    // =======================================================================
    // IMAGE DESCRIPTION: No longer inject images - description is in ToolMessage
    // =======================================================================
    // The image description is now generated synchronously in processToolCallContent
    // and returned as text in the ToolMessage content. No HumanMessage needed.

    return { toolMessage, stateUpdates, imageDescriptionToCache };
  };

  // Separate shell/install commands (run sequentially to prevent OOM) from other tools (run in parallel)
  // Shell commands like yarn build, yarn lint, yarn test consume significant memory
  // Running them in parallel can cause OOM (exit code 137) in sandboxes with limited resources
  const SEQUENTIAL_TOOLS = ["shell", "install_dependencies"];
  const sequentialCalls = toolCalls.filter(tc => SEQUENTIAL_TOOLS.includes(tc.name));
  const parallelCalls = toolCalls.filter(tc => !SEQUENTIAL_TOOLS.includes(tc.name));

  logger.info("Executing tool calls", {
    sequentialCount: sequentialCalls.length,
    parallelCount: parallelCalls.length,
    sequentialTools: sequentialCalls.map(tc => tc.name),
    parallelTools: parallelCalls.map(tc => tc.name),
  });

  // Execute sequential tools one at a time (shell commands that may consume lots of memory)
  const sequentialResults: { toolMessage: ToolMessage; stateUpdates: any }[] = [];
  for (const toolCall of sequentialCalls) {
    if (await isRunCancelled(config)) {
      break;
    }
    const result = await executeToolCall(toolCall);
    sequentialResults.push(result);
  }

  // Execute parallel tools concurrently (view, grep, textEditor - lightweight operations)
  let parallelResults;
  try {
    parallelResults = await Promise.all(parallelCalls.map(executeToolCall));
  } catch (error) {
    // Log the error for debugging
    logger.warn("Error during tool execution", {
      error: error instanceof Error ? error.message : String(error),
      sandboxSessionId: state.sandboxSessionId,
      isRunCancelled: isRunCancelledError(error),
    });
    // Handle "Run cancelled" error thrown from inside tool execution
    if (isRunCancelledError(error)) {
      return await handleRunCancelled(state.sandboxSessionId, "takeAction-toolExecution");
    }
    throw error;
  }

  // Combine results in original order
  const toolCallResultsWithUpdates: { toolMessage: ToolMessage; stateUpdates: any; imageDescriptionToCache?: { imagePath: string; description: any } }[] = [];
  let seqIndex = 0;
  let parIndex = 0;
  for (const toolCall of toolCalls) {
    if (SEQUENTIAL_TOOLS.includes(toolCall.name)) {
      toolCallResultsWithUpdates.push(sequentialResults[seqIndex++]);
    } else {
      toolCallResultsWithUpdates.push(parallelResults[parIndex++]);
    }
  }

  const toolCallResults = toolCallResultsWithUpdates.map(
    (item) => item.toolMessage,
  );

  // Image descriptions are now generated synchronously in processToolCallContent
  // Collect them for caching
  const imageDescriptionsToCache = toolCallResultsWithUpdates
    .map((item) => item.imageDescriptionToCache)
    .filter((desc): desc is { imagePath: string; description: any } => desc !== undefined);

  // merging document cache updates from tool calls
  const allStateUpdates = toolCallResultsWithUpdates
    .map((item) => item.stateUpdates)
    .filter(Boolean)
    .reduce(
      (acc: { documentCache: Record<string, string> }, update) => {
        if (update?.documentCache) {
          acc.documentCache = { ...acc.documentCache, ...update.documentCache };
        }
        return acc;
      },
      { documentCache: {} } as { documentCache: Record<string, string> },
    );

  // =======================================================================
  // Image descriptions are already generated - just add to cache
  // =======================================================================
  if (imageDescriptionsToCache.length > 0) {
    logger.info("Caching image descriptions", {
      count: imageDescriptionsToCache.length,
      paths: imageDescriptionsToCache.map(d => d.imagePath),
    });

    const imageDescriptionCacheUpdate: Record<string, any> = {};
    for (const desc of imageDescriptionsToCache) {
      imageDescriptionCacheUpdate[desc.imagePath] = desc.description;
    }

    (allStateUpdates as any).imageDescriptionCache = {
      ...(state.imageDescriptionCache ?? {}),
      ...imageDescriptionCacheUpdate,
    };
  }

  let wereDependenciesInstalled: boolean | null = null;
  toolCallResults.forEach((toolCallResult) => {
    if (toolCallResult.name === installDependenciesTool.name) {
      wereDependenciesInstalled = toolCallResult.status === "success";
    }
  });

  let branchName: string | undefined = state.branchName;
  let pullRequestNumber: number | undefined;
  let updatedTaskPlan: TaskPlan | undefined;
  let isRunCancelledByUser = false;

  logger.info("=== TAKE ACTION - CHECKING FOR COMMITS ===", {
    isLocalMode: isLocalMode(config),
    currentBranchName: branchName,
    targetBranch: state.targetRepository?.branch,
    isSameBranch: branchName === state.targetRepository?.branch,
  });

  if (!isLocalMode(config)) {
    const repoPath = getRepoAbsolutePath(state.targetRepository, undefined, sandboxInstance.providerType);

    let changedFiles: string[] = [];
    try {
      changedFiles = await getChangedFilesStatusWithInstance(repoPath, sandboxInstance, config);
    } catch (error) {
      // Log the error for debugging
      logger.warn("Error during git status check", {
        error: error instanceof Error ? error.message : String(error),
        sandboxSessionId: state.sandboxSessionId,
        isRunCancelled: isRunCancelledError(error),
      });
      // Handle "Run cancelled" error thrown from git status check
      if (isRunCancelledError(error)) {
        return await handleRunCancelled(state.sandboxSessionId, "takeAction-changedFilesCheck");
      }
      throw error;
    }

    logger.info("Changed files check in take-action", {
      changedFilesCount: changedFiles.length,
      changedFiles,
      branchName,
      targetBranch: state.targetRepository?.branch,
    });

    if (changedFiles.length > 0) {
      // Check if the run has been cancelled before committing
      isRunCancelledByUser = await isRunCancelled(config);
      if (isRunCancelledByUser) {
        logger.info("Skipping commit because run has been cancelled by user", {
          changedFilesCount: changedFiles.length,
        });
      } else {
        logger.info(`Has ${changedFiles.length} changed files. Committing.`, {
          changedFiles,
          branchName,
          targetBranch: state.targetRepository?.branch,
        });

        const { githubInstallationToken } =
          await getGitHubTokensFromConfig(config);
        const result = await checkoutBranchAndCommitWithInstance(
          config,
          state.targetRepository,
          sandboxInstance,
          {
            branchName,
            githubInstallationToken,
            taskPlan: state.taskPlan,
            githubIssueId: state.githubIssueId,
          },
        );

        logger.info("After checkoutBranchAndCommit in take-action", {
          oldBranchName: branchName,
          newBranchName: result.branchName,
          branchChanged: branchName !== result.branchName,
        });

        branchName = result.branchName;
        pullRequestNumber = result.updatedTaskPlan
          ? getActiveTask(result.updatedTaskPlan)?.pullRequestNumber
          : undefined;
        updatedTaskPlan = result.updatedTaskPlan;
      }
    }
  }

  const shouldRouteDiagnoseNode = shouldDiagnoseError([
    ...state.internalMessages,
    ...toolCallResults,
  ]);

  const codebaseTree = await getCodebaseTree(config, state.sandboxSessionId, state.targetRepository, sandboxInstance.providerType);
  // If the codebase tree failed to generate, fallback to the previous codebase tree, or if that's not defined, use the failed to generate message.
  const codebaseTreeToReturn =
    codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE
      ? (state.codebaseTree ?? codebaseTree)
      : codebaseTree;

  // Prioritize wereDependenciesInstalled over dependenciesInstalled
  const dependenciesInstalledUpdate =
    wereDependenciesInstalled !== null
      ? wereDependenciesInstalled
      : dependenciesInstalled !== null
        ? dependenciesInstalled
        : null;

  // Add the tool call messages for the draft PR to the user facing messages if a draft PR was opened
  const userFacingMessagesUpdate = [
    ...toolCallResults,
    ...(updatedTaskPlan && pullRequestNumber
      ? createPullRequestToolCallMessage(
        state.targetRepository,
        pullRequestNumber,
        true,
      )
      : []),
  ];

  // Include the modified message if it was filtered
  // Image descriptions are now text in ToolMessage - no HumanMessage images
  const internalMessagesUpdate =
    wasFiltered && modifiedMessage
      ? [modifiedMessage, ...toolCallResults]
      : [...toolCallResults];

  const commandUpdate: GraphUpdate = {
    messages: userFacingMessagesUpdate,
    internalMessages: internalMessagesUpdate,
    ...(branchName && { branchName }),
    ...(updatedTaskPlan && {
      taskPlan: updatedTaskPlan,
    }),
    codebaseTree: codebaseTreeToReturn,
    sandboxSessionId: sandboxInstance.id,
    ...(sandboxProviderType && { sandboxProviderType }),
    ...(dependenciesInstalledUpdate !== null && {
      dependenciesInstalled: dependenciesInstalledUpdate,
    }),
    ...allStateUpdates,
  };

  // If run was cancelled by user, cleanup sandbox and stop the graph immediately
  if (isRunCancelledByUser) {
    logger.warn("Stopping graph because run has been cancelled by user");

    // Cleanup sandbox on cancellation to avoid orphaned resources
    if (state.sandboxSessionId) {
      try {
        const deleted = await deleteSandbox(state.sandboxSessionId);
        logger.info("Sandbox cleanup on cancellation", {
          sandboxSessionId: state.sandboxSessionId,
          deleted,
        });
      } catch (cleanupError) {
        logger.warn("Failed to cleanup sandbox on cancellation", {
          sandboxSessionId: state.sandboxSessionId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }

    return new Command({
      goto: END,
      update: {
        ...commandUpdate,
        // Clear sandbox session ID since it's been deleted
        sandboxSessionId: undefined,
      },
    });
  }

  return new Command({
    goto: shouldRouteDiagnoseNode ? "diagnose-error" : "check-context-size",
    update: commandUpdate,
  });
}
