import { v4 as uuidv4 } from "uuid";
import { isAIMessage, ToolMessage } from "@langchain/core/messages";
import { createSessionPlanToolFields } from "../../../../tools/index.js";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  loadModel,
  supportsParallelToolCallsParam,
} from "../../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import {
  PlannerGraphState,
  PlannerGraphUpdate,
} from "@openswe/shared/open-swe/planner/types";
import { formatUserRequestPrompt } from "../../../../utils/user-request.js";
import {
  formatFollowupMessagePrompt,
  isFollowupRequest,
} from "../../utils/followup.js";
import { createLogger, LogLevel } from "../../../../utils/logger.js";
import { getProvider } from "../../../../utils/sandbox.js";
import { z } from "zod";
import { formatCustomRulesPrompt } from "../../../../utils/custom-rules.js";
import { getScratchpad } from "../../utils/scratchpad-notes.js";
import {
  SCRATCHPAD_PROMPT,
  SYSTEM_PROMPT,
  CUSTOM_FRAMEWORK_PROMPT,
} from "./prompt.js";
import { shouldUseCustomFramework } from "../../../../utils/should-use-custom-framework.js";
import { DO_NOT_RENDER_ID_PREFIX } from "@openswe/shared/constants";
import { filterMessagesWithoutContent } from "../../../../utils/message/content.js";
import { getModelManager } from "../../../../utils/llms/model-manager.js";
import { trackCachePerformance, convertMessagesToThinkingAwareMessages } from "../../../../utils/caching.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { isRunCancelled } from "../../../../utils/run-cancellation.js";
import { Command, END } from "@langchain/langgraph";

const logger = createLogger(LogLevel.INFO, "GeneratePlan");

function formatSystemPrompt(
  state: PlannerGraphState,
  config: GraphConfig,
): string {
  // It's a followup if there's more than one human message.
  const isFollowup = isFollowupRequest(state.taskPlan, state.proposedPlan);
  const scratchpad = getScratchpad(state.messages)
    .map((n) => `- ${n}`)
    .join("\n");
  return SYSTEM_PROMPT.replace(
    "{FOLLOWUP_MESSAGE_PROMPT}",
    isFollowup
      ? "\n" +
      formatFollowupMessagePrompt(state.taskPlan, state.proposedPlan) +
      "\n\n"
      : "",
  )
    .replace("{USER_REQUEST_PROMPT}", formatUserRequestPrompt(state.messages))
    .replaceAll("{CUSTOM_RULES}", formatCustomRulesPrompt(state.customRules))
    .replaceAll(
      "{SCRATCHPAD}",
      scratchpad.length
        ? SCRATCHPAD_PROMPT.replace("{SCRATCHPAD}", scratchpad)
        : "",
    )
    .replace(
      "{ADDITIONAL_INSTRUCTIONS}",
      shouldUseCustomFramework(config) ? CUSTOM_FRAMEWORK_PROMPT : "",
    );
}

export async function generatePlan(
  state: PlannerGraphState,
  config: GraphConfig,
): Promise<PlannerGraphUpdate | Command> {
  // Check if run was cancelled before executing
  if (await isRunCancelled(config)) {
    logger.warn("Stopping planner (generatePlan) because run has been cancelled by user");
    // Delete sandbox to release concurrency slot
    if (state.sandboxSessionId) {
      const { deleteSandbox } = await import("../../../../utils/sandbox.js");
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
    });
  }
  // Emit custom event: Starting plan generation
  config.writer?.({
    type: "planner_start",
    timestamp: Date.now(),
    message: "Starting plan generation",
  });

  const model = await loadModel(config, LLMTask.PLANNER);
  const modelManager = getModelManager();
  const modelName = modelManager.getModelNameForTask(config, LLMTask.PLANNER);
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.PLANNER,
  );
  const sessionPlanTool = createSessionPlanToolFields();

  config.writer?.({
    type: "planner_binding_tools",
    timestamp: Date.now(),
    toolName: sessionPlanTool.name,
  });

  const modelWithTools = model.bindTools([sessionPlanTool], {
    tool_choice: sessionPlanTool.name,
    ...(modelSupportsParallelToolCallsParam
      ? {
        parallel_tool_calls: false,
      }
      : {}),
  });

  let optionalToolMessage: ToolMessage | undefined;
  const lastMessage = state.messages[state.messages.length - 1];
  if (isAIMessage(lastMessage) && lastMessage.tool_calls?.[0]) {
    const lastMessageToolCall = lastMessage.tool_calls?.[0];
    optionalToolMessage = new ToolMessage({
      id: uuidv4(),
      tool_call_id: lastMessageToolCall.id ?? "",
      name: lastMessageToolCall.name,
      content: "Tool call not executed. Max actions reached.",
    });
  }

  const inputMessages = filterMessagesWithoutContent([
    ...state.messages,
    ...(optionalToolMessage ? [optionalToolMessage] : []),
  ]);
  if (!inputMessages.length) {
    throw new Error("No messages to process.");
  }

  config.writer?.({
    type: "planner_invoking_model",
    timestamp: Date.now(),
    messageCount: inputMessages.length,
    modelName,
  });

  // Retry configuration for missing tool_calls
  const MAX_RETRIES = 3;
  const INITIAL_DELAY_MS = 1000;

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  let response;
  let toolCall;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Check if run was cancelled before retry attempt
    if (attempt > 0 && await isRunCancelled(config)) {
      logger.warn("Stopping planner retry because run has been cancelled by user");
      return new Command({ goto: END });
    }

    if (attempt > 0) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(`Retrying plan generation (attempt ${attempt + 1}/${MAX_RETRIES}) after ${delay}ms`, {
        modelName,
        previousError: lastError?.message,
      });
      await sleep(delay);
    }

    response = await modelWithTools
      .withConfig({ tags: ["nostream"] })
      .invoke([
        {
          role: "system",
          content: formatSystemPrompt(state, config),
        },
        // Sanitize messages to remove cache_control from thinking blocks
        // Anthropic API rejects cache_control on thinking blocks
        ...convertMessagesToThinkingAwareMessages(inputMessages, { thinkingMode: true }),
      ]);

    config.writer?.({
      type: "planner_model_response",
      timestamp: Date.now(),
      hasToolCalls: !!response.tool_calls?.length,
      retryAttempt: attempt,
    });

    // Filter out empty plans
    response.tool_calls = response.tool_calls?.map((tc) => {
      if (tc.id === sessionPlanTool.name) {
        return {
          ...tc,
          args: {
            ...tc.args,
            plan: (tc.args as z.infer<typeof sessionPlanTool.schema>).plan.filter(
              (p) => p.length > 0,
            ),
          },
        };
      }
      return tc;
    });

    toolCall = response.tool_calls?.[0];
    if (toolCall) {
      // Success - break out of retry loop
      if (attempt > 0) {
        logger.info(`Plan generation succeeded on attempt ${attempt + 1}`, { modelName });
      }
      break;
    }

    // Log the failure and prepare for retry
    lastError = new Error("LLM response missing tool_calls");
    logger.warn(`Plan generation attempt ${attempt + 1} failed - no tool_calls in response`, {
      modelName,
      responseContent: typeof response.content === 'string'
        ? response.content.substring(0, 200)
        : JSON.stringify(response.content).substring(0, 200),
      hasToolCalls: !!response.tool_calls,
      toolCallsLength: response.tool_calls?.length ?? 0,
    });
  }

  if (!toolCall) {
    logger.error("Failed to generate plan after all retries", {
      modelName,
      maxRetries: MAX_RETRIES,
    });
    throw new Error("Failed to generate plan: LLM did not return expected tool call after retries");
  }

  let newSessionId: string | undefined;
  if (state.sandboxSessionId && !isLocalMode(config)) {
    // Stop before returning, as the next step will be to interrupt the graph.
    // Use provider abstraction to stop sandbox
    const provider = getProvider();
    await provider.stop(state.sandboxSessionId);
    newSessionId = state.sandboxSessionId;
  }

  const proposedPlanArgs = toolCall.args as z.infer<
    typeof sessionPlanTool.schema
  >;

  config.writer?.({
    type: "plan_generated",
    timestamp: Date.now(),
    title: proposedPlanArgs.title,
    planItemsCount: proposedPlanArgs.plan.length,
  });

  const toolResponse = new ToolMessage({
    id: `${DO_NOT_RENDER_ID_PREFIX}${uuidv4()}`,
    tool_call_id: toolCall.id ?? "",
    content: "Successfully saved plan.",
    name: sessionPlanTool.name,
  });

  return {
    messages: [response!, toolResponse],
    proposedPlanTitle: proposedPlanArgs.title,
    proposedPlan: proposedPlanArgs.plan,
    ...(newSessionId && { sandboxSessionId: newSessionId }),
    tokenData: trackCachePerformance(response!, modelName),
  };
}
