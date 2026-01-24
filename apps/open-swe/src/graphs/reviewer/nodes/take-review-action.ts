import { v4 as uuidv4 } from "uuid";
import {
  isAIMessage,
  isToolMessage,
  ToolMessage,
  AIMessage,
} from "@langchain/core/messages";
import {
  createInstallDependenciesTool,
  createShellTool,
  createReadImageTool,
} from "../../../tools/index.js";
import { GraphConfig, TaskPlan } from "@openswe/shared/open-swe/types";
import {
  ReviewerGraphState,
  ReviewerGraphUpdate,
} from "@openswe/shared/open-swe/reviewer/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { zodSchemaToString } from "../../../utils/zod-to-string.js";
import { formatBadArgsError } from "../../../utils/zod-to-string.js";
import { processToolCallContent } from "../../../utils/tool-output-processing.js";
import { createGrepTool } from "../../../tools/grep.js";

import {
  checkoutBranchAndCommitWithInstance,
  getChangedFilesStatusWithInstance,
} from "../../../utils/github/git.js";
import { getSandboxInstanceWithErrorHandling } from "../../../utils/sandbox.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { Command } from "@langchain/langgraph";
import { shouldDiagnoseError } from "../../../utils/tool-message-error.js";
import { filterHiddenMessages } from "../../../utils/message/filter-hidden.js";
import { getGitHubTokensFromConfig } from "../../../utils/github-tokens.js";
import { createScratchpadTool } from "../../../tools/scratchpad.js";
import { getActiveTask } from "@openswe/shared/open-swe/tasks";
import { createPullRequestToolCallMessage } from "../../../utils/message/create-pr-message.js";
import { createViewTool } from "../../../tools/builtin-tools/view.js";
import { filterUnsafeCommands } from "../../../utils/command-evaluation.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { normalizeToolCallArgs } from "../../../utils/normalize-tool-args.js";

const logger = createLogger(LogLevel.INFO, "TakeReviewAction");
import { isRunCancelled } from "../../../utils/run-cancellation.js";
import { END } from "@langchain/langgraph";

export async function takeReviewerActions(
  state: ReviewerGraphState,
  config: GraphConfig,
): Promise<Command> {
  if (await isRunCancelled(config)) {
    return new Command({
      goto: END,
    });
  }
  const { reviewerMessages } = state;
  const lastMessage = reviewerMessages[reviewerMessages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    throw new Error("Last message is not an AI message with tool calls.");
  }

  const shellTool = createShellTool(state, config);
  const searchTool = createGrepTool(state, config);
  const viewTool = createViewTool(state, config);
  const installDependenciesTool = createInstallDependenciesTool(state, config);
  const scratchpadTool = createScratchpadTool("");
  const readImageTool = createReadImageTool(state, config);
  const allTools = [
    shellTool,
    searchTool,
    viewTool,
    installDependenciesTool,
    scratchpadTool,
    readImageTool,
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

  const { sandboxInstance, codebaseTree, dependenciesInstalled, sandboxProviderType } =
    await getSandboxInstanceWithErrorHandling(
      state.sandboxSessionId,
      state.targetRepository,
      state.branchName,
      config,
    );

  // Helper function to execute a single tool call
  const executeToolCall = async (toolCall: typeof toolCalls[0]): Promise<{ toolMessage: ToolMessage; imageDescriptionToCache?: { imagePath: string; description: any } }> => {
    const tool = toolsMap[toolCall.name];
    if (!tool) {
      logger.error(`Unknown tool: ${toolCall.name}`);
      return {
        toolMessage: new ToolMessage({
          id: uuidv4(),
          tool_call_id: toolCall.id ?? "",
          content: `Unknown tool: ${toolCall.name}`,
          name: toolCall.name,
          status: "error",
        }),
      };
    }

    logger.info("Executing review action", {
      ...toolCall,
    });

    let result = "";
    let toolCallStatus: "success" | "error" = "success";
    try {
      // Normalize tool args before invoke to handle common AI model mistakes
      // (e.g., using 'pattern' instead of 'query' for grep tool)
      const normalizedArgs = normalizeToolCallArgs(toolCall.name, toolCall.args);
      const toolResult =
        // @ts-expect-error tool.invoke types are weird here...
        (await tool.invoke({
          ...normalizedArgs,
          // Only pass sandbox session ID in sandbox mode, not local mode
          ...(isLocalMode(config) ? {} : { xSandboxSessionId: sandboxInstance.id }),
        })) as {
          result: string;
          status: "success" | "error";
        };

      result = toolResult.result;
      toolCallStatus = toolResult.status;

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
          expectedSchema: zodSchemaToString(tool.schema),
        });
        result = formatBadArgsError(tool.schema, toolCall.args);
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

    // Process tool output with hybrid image analysis support
    const { content: toolMessageContent, imageDescriptionToCache } = await processToolCallContent(
      toolCall,
      result,
      {
        higherContextLimitToolNames: [], // Reviewer doesn't use MCP tools
        state: { documentCache: {}, imageDescriptionCache: (state as any).imageDescriptionCache ?? {} },
        config,
      },
    );

    const toolMessage = new ToolMessage({
      id: uuidv4(),
      tool_call_id: toolCall.id ?? "",
      content: toolMessageContent,
      name: toolCall.name,
      status: toolCallStatus,
    });

    // =======================================================================
    // IMAGE DESCRIPTION: No longer inject images - description is in ToolMessage
    // =======================================================================
    // Image description is now generated synchronously in processToolCallContent

    return { toolMessage, imageDescriptionToCache };
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
  const sequentialResults: { toolMessage: ToolMessage; imageDescriptionToCache?: { imagePath: string; description: any } }[] = [];
  for (const toolCall of sequentialCalls) {
    if (await isRunCancelled(config)) {
      break;
    }
    const result = await executeToolCall(toolCall);
    sequentialResults.push(result);
  }

  // Execute parallel tools concurrently (view, grep, scratchpad - lightweight operations)
  const parallelResults = await Promise.all(parallelCalls.map(executeToolCall));

  // Combine results in original order
  const toolCallResultsWithUpdates: { toolMessage: ToolMessage; imageDescriptionToCache?: { imagePath: string; description: any } }[] = [];
  let seqIndex = 0;
  let parIndex = 0;
  for (const toolCall of toolCalls) {
    if (SEQUENTIAL_TOOLS.includes(toolCall.name)) {
      toolCallResultsWithUpdates.push(sequentialResults[seqIndex++]);
    } else {
      toolCallResultsWithUpdates.push(parallelResults[parIndex++]);
    }
  }

  const toolCallResults = toolCallResultsWithUpdates.map(item => item.toolMessage);

  // Collect image descriptions for caching
  const imageDescriptionsToCache = toolCallResultsWithUpdates
    .map((item) => item.imageDescriptionToCache)
    .filter((desc): desc is { imagePath: string; description: any } => desc !== undefined);

  // =======================================================================
  // Image descriptions are already generated - just add to cache
  // =======================================================================
  let imageDescriptionCacheUpdate: Record<string, any> = {};
  if (imageDescriptionsToCache.length > 0) {
    logger.info("Caching image descriptions in reviewer", {
      count: imageDescriptionsToCache.length,
      paths: imageDescriptionsToCache.map(d => d.imagePath),
    });

    for (const desc of imageDescriptionsToCache) {
      imageDescriptionCacheUpdate[desc.imagePath] = desc.description;
    }
  }

  let branchName: string | undefined = state.branchName;
  let pullRequestNumber: number | undefined;
  let updatedTaskPlan: TaskPlan | undefined;

  if (!isLocalMode(config)) {
    const repoPath = getRepoAbsolutePath(state.targetRepository, config, sandboxInstance.providerType);
    const changedFiles = await getChangedFilesStatusWithInstance(repoPath, sandboxInstance, config);

    if (changedFiles.length > 0) {
      logger.info(`Has ${changedFiles.length} changed files. Committing.`, {
        changedFiles,
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
      branchName = result.branchName;
      pullRequestNumber = result.updatedTaskPlan
        ? getActiveTask(result.updatedTaskPlan)?.pullRequestNumber
        : undefined;
      updatedTaskPlan = result.updatedTaskPlan;
    }
  }

  let wereDependenciesInstalled: boolean | null = null;
  toolCallResults.forEach((toolCallResult) => {
    if (toolCallResult.name === installDependenciesTool.name) {
      wereDependenciesInstalled = toolCallResult.status === "success";
    }
  });

  // Prioritize wereDependenciesInstalled over dependenciesInstalled
  const dependenciesInstalledUpdate =
    wereDependenciesInstalled !== null
      ? wereDependenciesInstalled
      : dependenciesInstalled !== null
        ? dependenciesInstalled
        : null;

  logger.info("Completed review action", {
    ...toolCallResults.map((tc) => ({
      tool_call_id: tc.tool_call_id,
      status: tc.status,
    })),
  });

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
  const reviewerMessagesUpdate =
    wasFiltered && modifiedMessage
      ? [modifiedMessage, ...toolCallResults]
      : [...toolCallResults];

  const commandUpdate: ReviewerGraphUpdate = {
    messages: userFacingMessagesUpdate,
    reviewerMessages: reviewerMessagesUpdate,
    sandboxSessionId: sandboxInstance.id,
    ...(sandboxProviderType && { sandboxProviderType }),
    ...(branchName && { branchName }),
    ...(updatedTaskPlan && {
      taskPlan: updatedTaskPlan,
    }),
    ...(codebaseTree ? { codebaseTree } : {}),
    ...(dependenciesInstalledUpdate !== null && {
      dependenciesInstalled: dependenciesInstalledUpdate,
    }),
    // Merge imageDescriptionCache updates for hybrid image analysis
    ...(Object.keys(imageDescriptionCacheUpdate).length > 0 && {
      imageDescriptionCache: {
        ...((state as any).imageDescriptionCache ?? {}),
        ...imageDescriptionCacheUpdate,
      },
    }),
  };

  const maxReviewActions = config.configurable?.maxReviewActions ?? 30;
  const maxActionsCount = maxReviewActions * 2;
  // Exclude hidden messages, and messages that are not AI messages or tool messages.
  const filteredMessages = filterHiddenMessages([
    ...state.reviewerMessages,
    ...(commandUpdate.reviewerMessages ?? []),
  ]).filter((m) => isAIMessage(m) || isToolMessage(m));
  // If we've reached the max allowed review actions, go to final review.
  if (filteredMessages.length >= maxActionsCount) {
    logger.info("Exceeded max actions count, going to final review.", {
      maxActionsCount,
      filteredMessages,
    });
    return new Command({
      goto: "final-review",
      update: commandUpdate,
    });
  }

  const shouldRouteDiagnoseNode = shouldDiagnoseError([
    ...state.reviewerMessages,
    ...toolCallResults,
  ]);

  return new Command({
    goto: shouldRouteDiagnoseNode
      ? "diagnose-reviewer-error"
      : "generate-review-actions",
    update: commandUpdate,
  });
}
