import { v4 as uuidv4 } from "uuid";
import {
  isAIMessage,
  isToolMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import {
  createGetURLContentTool,
  createShellTool,
  createSearchDocumentForTool,
  createReadImageTool,
} from "../../../tools/index.js";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  PlannerGraphState,
  PlannerGraphUpdate,
} from "@openswe/shared/open-swe/planner/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import {
  safeSchemaToString,
  safeBadArgsError,
} from "../../../utils/zod-to-string.js";

import { createGrepTool } from "../../../tools/grep.js";
import {
  getChangedFilesStatusWithInstance,
  stashAndClearChanges,
} from "../../../utils/github/git.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { createScratchpadTool } from "../../../tools/scratchpad.js";
import { createReadyToPlanTool, READY_TO_PLAN_TOOL_NAME } from "../../../tools/ready-to-plan.js";
import { getMcpTools } from "../../../utils/mcp-client.js";
import { getSandboxInstanceWithErrorHandling } from "../../../utils/sandbox.js";
import { shouldDiagnoseError } from "../../../utils/tool-message-error.js";
import { Command, END } from "@langchain/langgraph";
import { filterHiddenMessages } from "../../../utils/message/filter-hidden.js";
import { DO_NOT_RENDER_ID_PREFIX } from "@openswe/shared/constants";
import { processToolCallContent } from "../../../utils/tool-output-processing.js";
import { createViewTool } from "../../../tools/builtin-tools/view.js";
import { isRunCancelled } from "../../../utils/run-cancellation.js";
import { normalizeToolCallArgs } from "../../../utils/normalize-tool-args.js";
import { getConfigNumber } from "@openswe/shared/dynamic-config";

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
  logger.warn(`Stopping planner (${source}) because run was cancelled by user (caught error)`);
  if (sandboxSessionId) {
    const { deleteSandbox } = await import("../../../utils/sandbox.js");
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
    update: {},
  });
}

export async function takeActions(
  state: PlannerGraphState,
  config: GraphConfig,
): Promise<Command> {
  // Check if run was cancelled before executing tool calls
  if (await isRunCancelled(config)) {
    logger.warn("Stopping planner because run has been cancelled by user");
    // Delete sandbox to release concurrency slot
    if (state.sandboxSessionId) {
      const { deleteSandbox } = await import("../../../utils/sandbox.js");
      try {
        await deleteSandbox(state.sandboxSessionId);
        logger.info("Sandbox deleted after planner run was cancelled", {
          sandboxSessionId: state.sandboxSessionId,
        });
      } catch (deleteError) {
        logger.warn("Failed to delete sandbox after planner cancellation", {
          sandboxSessionId: state.sandboxSessionId,
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
        });
      }
    }
    return new Command({
      goto: END,
      update: {},
    });
  }

  const { messages } = state;
  const lastMessage = messages[messages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    throw new Error("Last message is not an AI message with tool calls.");
  }

  const viewTool = createViewTool(state, config);
  const shellTool = createShellTool(state, config);
  const searchTool = createGrepTool(state, config);
  const scratchpadTool = createScratchpadTool("");
  const readyToPlanTool = createReadyToPlanTool();
  const getURLContentTool = createGetURLContentTool(state);
  const searchDocumentForTool = createSearchDocumentForTool(state, config);
  const mcpTools = await getMcpTools(config);

  const higherContextLimitToolNames = [
    ...mcpTools.map((t) => t.name),
    getURLContentTool.name,
    searchDocumentForTool.name,
  ];

  const allTools = [
    viewTool,
    shellTool,
    searchTool,
    scratchpadTool,
    readyToPlanTool,
    getURLContentTool,
    searchDocumentForTool,
    createReadImageTool(state, config),
    ...mcpTools,
  ];
  const toolsMap = Object.fromEntries(
    allTools.map((tool) => [tool.name, tool]),
  );

  const toolCalls = lastMessage.tool_calls;
  if (!toolCalls?.length) {
    throw new Error("No tool calls found.");
  }

  const { sandboxInstance, codebaseTree, dependenciesInstalled, sandboxProviderType } =
    await getSandboxInstanceWithErrorHandling(
      state.sandboxSessionId,
      state.targetRepository,
      state.branchName,
      config,
    );

  const toolCallResultsPromise = toolCalls.map(async (toolCall) => {
    const tool = toolsMap[toolCall.name];
    if (!tool) {
      logger.error(`Unknown tool: ${toolCall.name}`);
      const toolMessage = new ToolMessage({
        id: `${DO_NOT_RENDER_ID_PREFIX}${uuidv4()}`,
        tool_call_id: toolCall.id ?? "",
        content: `Unknown tool: ${toolCall.name}`,
        name: toolCall.name,
        status: "error",
      });

      return { toolMessage, stateUpdates: undefined };
    }

    logger.info("Executing planner tool action", {
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
    // Image description is now generated synchronously in processToolCallContent

    return { toolMessage, stateUpdates, imageDescriptionToCache };
  });

  let toolCallResultsWithUpdates;
  try {
    toolCallResultsWithUpdates = await Promise.all(toolCallResultsPromise);
  } catch (error) {
    // Log the error for debugging
    logger.warn("Error during tool execution", {
      error: error instanceof Error ? error.message : String(error),
      sandboxSessionId: state.sandboxSessionId,
      isRunCancelled: isRunCancelledError(error),
    });
    // Handle "Run cancelled" error thrown from inside tool execution (e.g., daytona-provider.ts)
    if (isRunCancelledError(error)) {
      return await handleRunCancelled(state.sandboxSessionId, "takeActions-toolExecution");
    }
    throw error;
  }
  let toolCallResults = toolCallResultsWithUpdates.map(
    (item) => item.toolMessage,
  );

  // Collect image descriptions for caching
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
    logger.info("Caching image descriptions in planner", {
      count: imageDescriptionsToCache.length,
      paths: imageDescriptionsToCache.map(d => d.imagePath),
    });

    const imageDescriptionCacheUpdate: Record<string, any> = {};
    for (const desc of imageDescriptionsToCache) {
      imageDescriptionCacheUpdate[desc.imagePath] = desc.description;
    }

    (allStateUpdates as any).imageDescriptionCache = {
      ...((state as any).imageDescriptionCache ?? {}),
      ...imageDescriptionCacheUpdate,
    };
  }

  if (!isLocalMode(config)) {
    const repoPath = isLocalMode(config)
      ? getLocalWorkingDirectory()
      : getRepoAbsolutePath(state.targetRepository, undefined, sandboxInstance.providerType);

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
        return await handleRunCancelled(state.sandboxSessionId, "takeActions-changedFilesCheck");
      }
      throw error;
    }

    if (changedFiles?.length > 0) {
      logger.warn(
        "Changes found in the codebase after taking action. Reverting.",
        {
          changedFiles,
        },
      );
      try {
        await stashAndClearChanges(repoPath, null);
      } catch (error) {
        // Log the error for debugging
        logger.warn("Error during stash changes", {
          error: error instanceof Error ? error.message : String(error),
          sandboxSessionId: state.sandboxSessionId,
          isRunCancelled: isRunCancelledError(error),
        });
        if (isRunCancelledError(error)) {
          return await handleRunCancelled(state.sandboxSessionId, "takeActions-stashChanges");
        }
        throw error;
      }

      // Rewrite the tool call contents to include a changed files warning.
      toolCallResults = toolCallResults.map(
        (tc) =>
          new ToolMessage({
            ...tc,
            content: `**WARNING**: THIS TOOL, OR A PREVIOUS TOOL HAS CHANGED FILES IN THE REPO.
  Remember that you are only permitted to take **READ** actions during the planning step. The changes have been reverted.
  
  Please ensure you only take read actions during the planning step to gather context. You may also call the \`take_notes\` tool at any time to record important information for the programmer step.
  
  Command Output:\n
  ${tc.content}`,
          }),
      );
    }
  }

  logger.info("Completed planner tool action", {
    ...toolCallResults.map((tc) => ({
      tool_call_id: tc.tool_call_id,
      status: tc.status,
    })),
  });

  const commandUpdate: PlannerGraphUpdate = {
    messages: [...toolCallResults],
    sandboxSessionId: sandboxInstance.id,
    ...(sandboxProviderType && { sandboxProviderType }),
    ...(codebaseTree && { codebaseTree }),
    ...(dependenciesInstalled !== null && { dependenciesInstalled }),
    ...allStateUpdates,
  };

  // Priority: Dynamic config > config > default (75)
  // Dynamic config allows runtime adjustment without recompilation
  const envMaxContextActions = getConfigNumber("MAX_CONTEXT_ACTIONS");
  const maxContextActions = envMaxContextActions ?? config.configurable?.maxContextActions ?? 75;
  const maxActionsCount = maxContextActions * 2;
  // Exclude hidden messages, and messages that are not AI messages or tool messages.
  const filteredMessages = filterHiddenMessages([
    ...state.messages,
    ...(commandUpdate.messages ?? []),
  ]).filter((m) => isAIMessage(m) || isToolMessage(m));
  if (filteredMessages.length >= maxActionsCount) {
    // If we've exceeded the max actions count, we should generate a plan.
    logger.info("Exceeded max actions count, generating plan.", {
      maxActionsCount,
      filteredMessages,
    });
    return new Command({
      goto: "generate-plan",
      update: commandUpdate,
    });
  }

  // Check if AI called ready_to_plan tool - this signals AI wants to generate plan
  const readyToPlanCalled = toolCalls.some(
    (tc) => tc.name === READY_TO_PLAN_TOOL_NAME
  );
  if (readyToPlanCalled) {
    logger.info("AI signaled ready to plan via ready_to_plan tool, transitioning to generate-plan");
    return new Command({
      goto: "generate-plan",
      update: commandUpdate,
    });
  }

  const shouldRouteDiagnoseNode = shouldDiagnoseError([
    ...state.messages,
    ...toolCallResults,
  ]);

  return new Command({
    goto: shouldRouteDiagnoseNode
      ? "diagnose-error"
      : "generate-plan-context-action",
    update: commandUpdate,
  });
}
