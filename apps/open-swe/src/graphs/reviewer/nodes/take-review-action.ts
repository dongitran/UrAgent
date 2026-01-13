import { v4 as uuidv4 } from "uuid";
import {
  isAIMessage,
  isToolMessage,
  ToolMessage,
  AIMessage,
  HumanMessage,
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
import { processToolCallContent, generateAndCacheImageDescription } from "../../../utils/tool-output-processing.js";
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
  const executeToolCall = async (toolCall: typeof toolCalls[0]): Promise<{ toolMessage: ToolMessage; imageMessage?: HumanMessage; pendingImageDescription?: { imagePath: string; base64DataUrl: string } }> => {
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
      const toolResult =
        // @ts-expect-error tool.invoke types are weird here...
        (await tool.invoke({
          ...toolCall.args,
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
    const { content: toolMessageContent, pendingImageDescription } = await processToolCallContent(
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
    // HYBRID IMAGE ANALYSIS: Handle image messages based on first-read status
    // =======================================================================
    // If this is read_image tool with successful image result, create HumanMessage with image content
    // This is needed because Gemini FunctionResponse is JSON-only and cannot contain inline images
    // The image must be re-introduced as new input in a HumanMessage
    // For CACHED READS (description instead of base64), we skip the image message
    let imageMessage: HumanMessage | undefined;
    if (toolCall.name === "read_image" && toolCallStatus === "success") {
      if (pendingImageDescription) {
        // FIRST READ: Create HumanMessage with actual image for visual analysis
        logger.info("Creating HumanMessage with image content for first read_image result in reviewer", {
          imagePath: pendingImageDescription.imagePath,
          base64Length: pendingImageDescription.base64DataUrl.length,
        });
        imageMessage = new HumanMessage({
          content: [
            {
              type: "image_url",
              image_url: { url: pendingImageDescription.base64DataUrl },
            },
            {
              type: "text",
              text: "Above is the image you requested via read_image tool. Use it as visual reference for your review. A text description will be cached for subsequent references.",
            },
          ],
        });
      } else if (toolMessageContent.startsWith("data:image/")) {
        // FALLBACK: Raw base64 result (backward compatibility)
        logger.info("Creating HumanMessage with image content for read_image result (fallback)", {
          imageDataUrlLength: toolMessageContent.length,
        });
        imageMessage = new HumanMessage({
          content: [
            {
              type: "image_url",
              image_url: { url: toolMessageContent },
            },
            {
              type: "text",
              text: "Above is the image you requested via read_image tool. Use it as visual reference for your review.",
            },
          ],
        });
      }
    }
    // CACHED READ: No image message needed - the text description is in the tool message content

    return { toolMessage, imageMessage, pendingImageDescription };
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
  const sequentialResults: { toolMessage: ToolMessage; imageMessage?: HumanMessage; pendingImageDescription?: { imagePath: string; base64DataUrl: string } }[] = [];
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
  const toolCallResultsWithUpdates: { toolMessage: ToolMessage; imageMessage?: HumanMessage; pendingImageDescription?: { imagePath: string; base64DataUrl: string } }[] = [];
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
  // Collect image messages from read_image tool calls
  const imageMessages = toolCallResultsWithUpdates
    .map((item) => item.imageMessage)
    .filter((msg): msg is HumanMessage => msg !== undefined);

  // =======================================================================
  // HYBRID IMAGE ANALYSIS: Generate descriptions for first-time image reads
  // =======================================================================
  const pendingImageDescriptions = toolCallResultsWithUpdates
    .map((item) => item.pendingImageDescription)
    .filter((pd): pd is { imagePath: string; base64DataUrl: string } => pd !== undefined);

  // Generate image descriptions synchronously and add to state updates
  let imageDescriptionCacheUpdate: Record<string, any> = {};
  if (pendingImageDescriptions.length > 0) {
    logger.info("Generating image descriptions for caching in reviewer", {
      count: pendingImageDescriptions.length,
      paths: pendingImageDescriptions.map(pd => pd.imagePath),
    });

    const descriptionPromises = pendingImageDescriptions.map(async (pd) => {
      try {
        const cache = await generateAndCacheImageDescription(
          pd.imagePath,
          pd.base64DataUrl,
          config,
          (state as any).imageDescriptionCache ?? {},
        );
        logger.info("Image description generated and cached", {
          imagePath: pd.imagePath,
        });
        return cache;
      } catch (err) {
        logger.error("Failed to generate image description", {
          imagePath: pd.imagePath,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    });

    const results = await Promise.all(descriptionPromises);
    for (const cache of results) {
      if (cache) {
        imageDescriptionCacheUpdate = { ...imageDescriptionCacheUpdate, ...cache };
      }
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
  // Also include image messages for multimodal processing
  const reviewerMessagesUpdate =
    wasFiltered && modifiedMessage
      ? [modifiedMessage, ...toolCallResults, ...imageMessages]
      : [...toolCallResults, ...imageMessages];

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
