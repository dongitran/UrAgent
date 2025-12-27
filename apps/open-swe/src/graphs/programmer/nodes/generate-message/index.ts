import { v4 as uuidv4 } from "uuid";
import {
  GraphState,
  GraphConfig,
  GraphUpdate,
  TaskPlan,
} from "@openswe/shared/open-swe/types";
import {
  getModelManager,
  loadModel,
  Provider,
  supportsParallelToolCallsParam,
} from "../../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import {
  createShellTool,
  createApplyPatchTool,
  createRequestHumanHelpToolFields,
  createUpdatePlanToolFields,
  createGetURLContentTool,
  createSearchDocumentForTool,
  createWriteDefaultTsConfigTool,
} from "../../../../tools/index.js";
import { formatPlanPrompt } from "../../../../utils/plan-prompt.js";
import { stopSandbox } from "../../../../utils/sandbox.js";
import { createLogger, LogLevel } from "../../../../utils/logger.js";
import { getCurrentPlanItem } from "../../../../utils/current-task.js";
import { getMessageContentString } from "@openswe/shared/messages";
import { getActivePlanItems } from "@openswe/shared/open-swe/tasks";
import {
  CODE_REVIEW_PROMPT,
  DEPENDENCIES_INSTALLED_PROMPT,
  DEPENDENCIES_NOT_INSTALLED_PROMPT,
  DYNAMIC_SYSTEM_PROMPT,
  STATIC_ANTHROPIC_SYSTEM_INSTRUCTIONS,
  STATIC_SYSTEM_INSTRUCTIONS,
  CUSTOM_FRAMEWORK_PROMPT,
} from "./prompt.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getMissingMessages } from "../../../../utils/github/issue-messages.js";
import { getPlansFromIssue } from "../../../../utils/github/issue-task.js";
import { createGrepTool } from "../../../../tools/grep.js";
import { createViewTool } from "../../../../tools/builtin-tools/view.js";
import { createInstallDependenciesTool } from "../../../../tools/install-dependencies.js";
import { formatCustomRulesPrompt } from "../../../../utils/custom-rules.js";
import { getMcpTools } from "../../../../utils/mcp-client.js";
import {
  formatCodeReviewPrompt,
  getCodeReviewFields,
} from "../../../../utils/review.js";
import { filterMessagesWithoutContent } from "../../../../utils/message/content.js";
import {
  CacheablePromptSegment,
  convertMessagesToCacheControlledMessages,
  trackCachePerformance,
} from "../../../../utils/caching.js";
import { createMarkTaskCompletedToolFields } from "@openswe/shared/open-swe/tools";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  BaseMessageLike,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { shouldCreateIssue } from "../../../../utils/should-create-issue.js";
import {
  createReplyToReviewCommentTool,
  createReplyToCommentTool,
  shouldIncludeReviewCommentTool,
  createReplyToReviewTool,
} from "../../../../tools/reply-to-review-comment.js";
import { shouldUseCustomFramework } from "../../../../utils/should-use-custom-framework.js";
import {
  detectLoop,
  generateLoopWarningPrompt,
} from "../../../../utils/loop-detection.js";

const logger = createLogger(LogLevel.INFO, "GenerateMessageNode");

const formatDynamicContextPrompt = (state: GraphState) => {
  const activePlanItems = state.taskPlan
    ? getActivePlanItems(state.taskPlan)
    : [];
  const planString = activePlanItems
    .map((i) => `<plan-item index="${i.index}">\n${i.plan}\n</plan-item>`)
    .join("\n");
  return DYNAMIC_SYSTEM_PROMPT.replaceAll(
    "{PLAN_PROMPT}",
    planString || "No plan available",
  )
    .replaceAll(
      "{PLAN_GENERATION_NOTES}",
      state.contextGatheringNotes || "No context gathering notes available.",
    )
    .replaceAll("{REPO_DIRECTORY}", getRepoAbsolutePath(state.targetRepository))
    .replaceAll(
      "{DEPENDENCIES_INSTALLED_PROMPT}",
      state.dependenciesInstalled
        ? DEPENDENCIES_INSTALLED_PROMPT
        : DEPENDENCIES_NOT_INSTALLED_PROMPT,
    )
    .replaceAll(
      "{CODEBASE_TREE}",
      state.codebaseTree || "No codebase tree generated yet.",
    );
};

const formatStaticInstructionsPrompt = (
  state: GraphState,
  config: GraphConfig,
  isAnthropicModel: boolean,
) => {
  return (
    isAnthropicModel
      ? STATIC_ANTHROPIC_SYSTEM_INSTRUCTIONS
      : STATIC_SYSTEM_INSTRUCTIONS
  )
    .replaceAll("{REPO_DIRECTORY}", getRepoAbsolutePath(state.targetRepository))
    .replaceAll("{CUSTOM_RULES}", formatCustomRulesPrompt(state.customRules))
    .replace(
      "{CUSTOM_FRAMEWORK_PROMPT}",
      shouldUseCustomFramework(config) ? CUSTOM_FRAMEWORK_PROMPT : "",
    )
    .replace("{DEV_SERVER_PROMPT}", ""); // Always empty until we add dev server tool
};

const formatCacheablePrompt = (
  state: GraphState,
  config: GraphConfig,
  args?: {
    isAnthropicModel?: boolean;
    excludeCacheControl?: boolean;
  },
): CacheablePromptSegment[] => {
  const codeReview = getCodeReviewFields(state.internalMessages);

  const segments: CacheablePromptSegment[] = [
    // Cache Breakpoint 2: Static Instructions
    {
      type: "text",
      text: formatStaticInstructionsPrompt(
        state,
        config,
        !!args?.isAnthropicModel,
      ),
      ...(!args?.excludeCacheControl
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    },

    // Cache Breakpoint 3: Dynamic Context
    {
      type: "text",
      text: formatDynamicContextPrompt(state),
    },
  ];

  // Cache Breakpoint 4: Code Review Context (only add if present)
  if (codeReview) {
    segments.push({
      type: "text",
      text: formatCodeReviewPrompt(CODE_REVIEW_PROMPT, {
        review: codeReview.review,
        newActions: codeReview.newActions,
      }),
      ...(!args?.excludeCacheControl
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    });
  }

  return segments.filter((segment) => segment.text.trim() !== "");
};

const planSpecificPrompt = `<detailed_plan_information>
Here is the task execution plan for the request you're working on.
Ensure you carefully read through all of the instructions, messages, and context provided above.
Once you have a clear understanding of the current state of the task, analyze the plan provided below, and take an action based on it.
You're provided with the full list of tasks, including the completed, current and remaining tasks.

You are in the process of executing the current task:

{PLAN_PROMPT}
</detailed_plan_information>

{LOOP_WARNING}`;

const formatSpecificPlanPrompt = (
  taskPlan: TaskPlan | null | undefined,
  loopWarning: string = "",
): HumanMessage => {
  const activePlanItems = taskPlan ? getActivePlanItems(taskPlan) : [];
  return new HumanMessage({
    id: uuidv4(),
    content: planSpecificPrompt
      .replace(
        "{PLAN_PROMPT}",
        activePlanItems.length > 0
          ? formatPlanPrompt(activePlanItems)
          : "No plan available - execute the user request directly.",
      )
      .replace("{LOOP_WARNING}", loopWarning),
  });
};

async function createToolsAndPrompt(
  state: GraphState,
  config: GraphConfig,
  options: {
    latestTaskPlan: TaskPlan | null;
    missingMessages: BaseMessage[];
    loopWarning?: string;
  },
): Promise<{
  providerTools: Record<Provider, BindToolsInput[]>;
  providerMessages: Record<Provider, BaseMessageLike[]>;
}> {
  const mcpTools = await getMcpTools(config);
  const sharedTools = [
    createGrepTool(state, config),
    createViewTool(state, config),
    createShellTool(state, config),
    createRequestHumanHelpToolFields(),
    createUpdatePlanToolFields(),
    createGetURLContentTool(state),
    createInstallDependenciesTool(state, config),
    createMarkTaskCompletedToolFields(),
    createSearchDocumentForTool(state, config),
    createWriteDefaultTsConfigTool(state, config),
    ...(shouldIncludeReviewCommentTool(state, config)
      ? [
          createReplyToReviewCommentTool(state, config),
          createReplyToCommentTool(state, config),
          createReplyToReviewTool(state, config),
        ]
      : []),
    ...mcpTools,
  ];

  logger.info(
    `MCP tools added to Programmer: ${mcpTools.map((t) => t.name).join(", ")}`,
  );

  const anthropicModelTools = [
    ...sharedTools,
    {
      type: "text_editor_20250728",
      name: "str_replace_based_edit_tool",
      cache_control: { type: "ephemeral" },
    },
  ];
  const nonAnthropicModelTools = [
    ...sharedTools,
    {
      ...createApplyPatchTool(state, config),
      cache_control: { type: "ephemeral" },
    },
  ];

  const rawMessages = [...state.internalMessages, ...options.missingMessages];

  logger.error("[Gemini Debug] Raw messages BEFORE filtering", {
    totalRawMessages: rawMessages.length,
    rawMessageDetails: rawMessages.map((m: BaseMessage, idx: number) => ({
      index: idx,
      type: m.constructor.name,
      role: m._getType?.() || "unknown",
      hasContent: !!m.content,
      contentLength:
        typeof m.content === "string"
          ? m.content.length
          : Array.isArray(m.content)
            ? m.content.length
            : "N/A",
      contentPreview:
        typeof m.content === "string"
          ? m.content.substring(0, 100)
          : JSON.stringify(m.content)?.substring(0, 100),
      isHidden: !!m.additional_kwargs?.hidden,
      additionalKwargs: m.additional_kwargs,
    })),
  });

  const inputMessages = filterMessagesWithoutContent(rawMessages);

  logger.error("[Gemini Debug] Input messages after filtering", {
    totalInternalMessages: state.internalMessages.length,
    totalMissingMessages: options.missingMessages.length,
    filteredInputMessages: inputMessages.length,
    inputMessageDetails: inputMessages.map((m: BaseMessage, idx: number) => ({
      index: idx,
      type: m.constructor.name,
      role: m._getType?.() || "unknown",
      hasContent: !!m.content,
      contentLength: typeof m.content === "string" ? m.content.length : "N/A",
      hasToolCalls: !!(m as AIMessage).tool_calls?.length,
      toolCallsCount: (m as AIMessage).tool_calls?.length || 0,
      toolCallNames: (m as AIMessage).tool_calls?.map((tc) => tc.name) || [],
    })),
  });

  if (!inputMessages.length) {
    throw new Error("No messages to process.");
  }

  const loopWarning = options.loopWarning || "";
  const effectiveTaskPlan = options.latestTaskPlan ?? state.taskPlan;

  logger.error("[Gemini Debug] Building message arrays", {
    loopWarning: !!loopWarning,
    hasEffectiveTaskPlan: !!effectiveTaskPlan,
    inputMessagesCount: inputMessages.length,
  });

  const anthropicMessages = [
    {
      role: "system",
      content: formatCacheablePrompt(
        {
          ...state,
          taskPlan: effectiveTaskPlan,
        },
        config,
        {
          isAnthropicModel: true,
          excludeCacheControl: false,
        },
      ),
    },
    ...convertMessagesToCacheControlledMessages(inputMessages),
    formatSpecificPlanPrompt(effectiveTaskPlan, loopWarning),
  ];

  const nonAnthropicMessages = [
    {
      role: "system",
      content: formatCacheablePrompt(
        {
          ...state,
          taskPlan: effectiveTaskPlan,
        },
        config,
        {
          isAnthropicModel: false,
          excludeCacheControl: true,
        },
      ),
    },
    ...inputMessages,
    formatSpecificPlanPrompt(effectiveTaskPlan, loopWarning),
  ];

  // Gemini has strict message ordering requirements:
  // 1. Messages must start with HumanMessage
  // 2. Roles must alternate between 'user' and 'ai'
  // 3. Multiple consecutive ToolMessages (from parallel tool calls) must be merged
  // 4. Cannot end with AIMessage that has tool_calls

  const processedMessages: BaseMessage[] = [];
  let i = 0;

  while (i < inputMessages.length) {
    const currentMsg = inputMessages[i];
    const currentType = currentMsg.constructor.name;

    // Check if this is a ToolMessage and if there are more ToolMessages following
    if (currentType === "ToolMessage") {
      const toolMessages: ToolMessage[] = [currentMsg as ToolMessage];
      let j = i + 1;

      // Collect all consecutive ToolMessages
      while (
        j < inputMessages.length &&
        inputMessages[j].constructor.name === "ToolMessage"
      ) {
        toolMessages.push(inputMessages[j] as ToolMessage);
        j++;
      }

      if (toolMessages.length > 1) {
        // Merge multiple ToolMessages into one
        const mergedContent = toolMessages
          .map(
            (msg, idx) =>
              `[Tool Response ${idx + 1}]\n${getMessageContentString(msg.content)}`,
          )
          .join("\n\n");

        const firstToolMsg = toolMessages[0];
        const mergedToolMessage = new ToolMessage({
          content: mergedContent,
          tool_call_id: firstToolMsg.tool_call_id,
          name: firstToolMsg.name,
          additional_kwargs: firstToolMsg.additional_kwargs || {},
        });

        processedMessages.push(mergedToolMessage);

        logger.error("[Gemini Debug] Merged consecutive ToolMessages", {
          originalCount: toolMessages.length,
          startIndex: i,
          endIndex: j - 1,
          toolCallIds: toolMessages.map((m) => m.tool_call_id),
        });

        i = j;
      } else {
        processedMessages.push(currentMsg);
        i++;
      }
    } else {
      processedMessages.push(currentMsg);
      i++;
    }
  }

  // Remove trailing AIMessages with tool_calls
  while (processedMessages.length > 0) {
    const lastMsg = processedMessages[processedMessages.length - 1];
    const lastMsgToolCalls = (lastMsg as AIMessage).tool_calls;
    const isAIWithToolCalls =
      (lastMsg.constructor.name === "AIMessage" ||
        lastMsg.constructor.name === "AIMessageChunk") &&
      lastMsgToolCalls &&
      lastMsgToolCalls.length > 0;

    if (isAIWithToolCalls) {
      logger.error(
        "[Gemini Debug] Removing trailing AIMessage with tool_calls",
        {
          messageIndex: processedMessages.length - 1,
          toolCallsCount: lastMsgToolCalls.length,
        },
      );
      processedMessages.pop();
    } else {
      break;
    }
  }

  // Gemini requires: function call turn must come immediately after user turn or function response turn
  // If first message is AIMessage with tool_calls, we need to add a HumanMessage before it
  // or remove leading AIMessages with tool_calls that don't have corresponding tool responses
  while (processedMessages.length > 0) {
    const firstMsg = processedMessages[0];
    const firstMsgToolCalls = (firstMsg as AIMessage).tool_calls;
    const isAIWithToolCalls =
      (firstMsg.constructor.name === "AIMessage" ||
        firstMsg.constructor.name === "AIMessageChunk") &&
      firstMsgToolCalls &&
      firstMsgToolCalls.length > 0;

    if (isAIWithToolCalls) {
      // Check if next message is a ToolMessage (function response)
      if (
        processedMessages.length > 1 &&
        processedMessages[1].constructor.name === "ToolMessage"
      ) {
        // Insert a placeholder HumanMessage before the AIMessage with tool_calls
        const placeholderHumanMessage = new HumanMessage({
          id: uuidv4(),
          content: "Continue with the task execution.",
        });
        processedMessages.unshift(placeholderHumanMessage);
        logger.error(
          "[Gemini Debug] Inserted placeholder HumanMessage before AIMessage with tool_calls",
          {
            aiMessageToolCallsCount: firstMsgToolCalls.length,
          },
        );
        break;
      } else {
        // Remove orphan AIMessage with tool_calls (no corresponding tool response)
        logger.error(
          "[Gemini Debug] Removing leading AIMessage with tool_calls (no tool response)",
          {
            messageIndex: 0,
            toolCallsCount: firstMsgToolCalls.length,
          },
        );
        processedMessages.shift();
      }
    } else {
      break;
    }
  }

  const geminiMessages = [
    {
      role: "system",
      content: formatCacheablePrompt(
        {
          ...state,
          taskPlan: effectiveTaskPlan,
        },
        config,
        {
          isAnthropicModel: false,
          excludeCacheControl: true,
        },
      ),
    },
    ...processedMessages,
    formatSpecificPlanPrompt(effectiveTaskPlan, loopWarning),
  ];

  logger.error("[Gemini Debug] Message structure prepared", {
    totalInputMessages: inputMessages.length,
    anthropicMessagesCount: anthropicMessages.length,
    nonAnthropicMessagesCount: nonAnthropicMessages.length,
    geminiMessagesCount: geminiMessages.length,
    messageTypes: inputMessages.map((m: any) => ({
      type: m.constructor.name,
      role: m.role || m._getType?.(),
      hasToolCalls: !!m.tool_calls?.length,
      toolCallsCount: m.tool_calls?.length || 0,
    })),
  });

  logger.error("[Gemini Debug] Detailed Gemini message sequence", {
    messages: geminiMessages.map((m: any, idx: number) => {
      const isSystemMsg = typeof m === "object" && m.role === "system";
      const isLangChainMsg = m.constructor?.name?.includes("Message");

      return {
        index: idx,
        isSystemObject: isSystemMsg,
        isLangChainMessage: isLangChainMsg,
        type: m.constructor?.name || typeof m,
        role: m.role || m._getType?.(),
        hasContent: !!m.content,
        contentPreview:
          typeof m.content === "string"
            ? m.content.substring(0, 100) + "..."
            : Array.isArray(m.content)
              ? `Array[${m.content.length}]`
              : typeof m.content,
        hasToolCalls: !!m.tool_calls?.length,
        toolCallsCount: m.tool_calls?.length || 0,
        toolCallNames: m.tool_calls?.map((tc: any) => tc.name) || [],
      };
    }),
  });

  return {
    providerTools: {
      anthropic: anthropicModelTools,
      openai: nonAnthropicModelTools,
      "google-genai": nonAnthropicModelTools,
    },
    providerMessages: {
      anthropic: anthropicMessages,
      openai: nonAnthropicMessages,
      "google-genai": geminiMessages,
    },
  };
}

export async function generateAction(
  state: GraphState,
  config: GraphConfig,
): Promise<GraphUpdate> {
  // Emit custom event: Starting programmer action
  config.writer?.({
    type: "programmer_start",
    timestamp: Date.now(),
    message: "Starting programmer action generation",
  });

  const modelManager = getModelManager();
  const modelName = modelManager.getModelNameForTask(
    config,
    LLMTask.PROGRAMMER,
  );
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.PROGRAMMER,
  );
  const markTaskCompletedTool = createMarkTaskCompletedToolFields();
  const isAnthropicModel = modelName.includes("claude-");

  // Loop detection - check if agent is stuck in a loop
  const loopDetectionResult = detectLoop(state.internalMessages);

  if (loopDetectionResult.loopCount > 0) {
    config.writer?.({
      type: "loop_detected",
      timestamp: Date.now(),
      loopType: loopDetectionResult.loopType,
      loopCount: loopDetectionResult.loopCount,
      repeatedTool: loopDetectionResult.repeatedToolCall?.name,
    });
  }

  // Handle based on recommendation
  if (loopDetectionResult.recommendation === "force_complete") {
    config.writer?.({
      type: "force_complete",
      timestamp: Date.now(),
      reason: "loop_detected",
      loopType: loopDetectionResult.loopType,
      loopCount: loopDetectionResult.loopCount,
    });

    logger.warn("Force completing task due to loop detection", {
      loopType: loopDetectionResult.loopType,
      loopCount: loopDetectionResult.loopCount,
      repeatedTool: loopDetectionResult.repeatedToolCall?.name,
      isEditLoop: loopDetectionResult.isEditLoop,
      hasVaryingOutputs: loopDetectionResult.hasVaryingOutputs,
      warningCount: loopDetectionResult.warningCount,
    });

    // Create a synthetic mark_task_completed tool call
    const loopDescription = loopDetectionResult.isEditLoop
      ? `edit_loop (str_replace failing repeatedly on "${loopDetectionResult.repeatedToolCall?.name}")`
      : `${loopDetectionResult.loopType} loop`;

    const forcedCompletionResponse = new AIMessage({
      id: uuidv4(),
      content: `Task force-completed due to detected ${loopDescription} behavior.`,
      tool_calls: [
        {
          id: uuidv4(),
          name: markTaskCompletedTool.name,
          args: {
            completed_task_summary: `Task was automatically marked as completed because the agent was stuck in a ${loopDescription}, repeatedly calling "${loopDetectionResult.repeatedToolCall?.name}" ${loopDetectionResult.loopCount} times. The task appears to be complete based on the repeated verification attempts.`,
          },
        },
      ],
    });

    // Need to ensure taskPlan exists for handle-completed-task node
    let taskPlanForForceComplete = state.taskPlan;
    if (!taskPlanForForceComplete) {
      taskPlanForForceComplete = {
        tasks: [
          {
            id: "force-completed-task",
            taskIndex: 0,
            request: "Force completed due to loop",
            title: "Force Completed Task",
            createdAt: Date.now(),
            completed: false,
            planRevisions: [
              {
                revisionIndex: 0,
                plans: [
                  {
                    index: 0,
                    plan: "Task force-completed due to loop detection",
                    completed: false,
                  },
                ],
                createdAt: Date.now(),
                createdBy: "agent",
              },
            ],
            activeRevisionIndex: 0,
          },
        ],
        activeTaskIndex: 0,
      };
    }

    return {
      messages: [forcedCompletionResponse],
      internalMessages: [forcedCompletionResponse],
      taskPlan: taskPlanForForceComplete,
    };
  }

  // For error_retry or edit_loop that hit threshold, request human help instead
  if (loopDetectionResult.recommendation === "request_help") {
    const isEditLoop =
      loopDetectionResult.isEditLoop ||
      loopDetectionResult.loopType === "edit_loop";

    config.writer?.({
      type: "request_help",
      timestamp: Date.now(),
      reason: "loop_detected",
      loopType: loopDetectionResult.loopType,
      loopCount: loopDetectionResult.loopCount,
    });

    logger.warn("Requesting human help due to loop", {
      loopType: loopDetectionResult.loopType,
      loopCount: loopDetectionResult.loopCount,
      repeatedTool: loopDetectionResult.repeatedToolCall?.name,
      isEditLoop,
      hasVaryingOutputs: loopDetectionResult.hasVaryingOutputs,
    });

    // Create a synthetic request_human_help tool call
    const helpMessage = isEditLoop
      ? `I'm stuck in an edit loop where my file edits keep failing. I've tried to edit "${loopDetectionResult.repeatedToolCall?.name}" ${loopDetectionResult.loopCount} times without success. The str_replace_based_edit_tool keeps failing - possibly due to whitespace mismatch or the file content has changed. Please help me understand what's wrong or suggest a different approach (e.g., rewriting the entire file).`
      : `I'm stuck in a loop where the same action keeps failing. I've tried "${loopDetectionResult.repeatedToolCall?.name}" ${loopDetectionResult.loopCount} times without success. Please help me understand what's going wrong or suggest a different approach.`;

    const requestHelpResponse = new AIMessage({
      id: uuidv4(),
      content: `Requesting human help due to detected ${loopDetectionResult.loopType} loop - the same action keeps failing.`,
      tool_calls: [
        {
          id: uuidv4(),
          name: "request_human_help",
          args: {
            help_request: helpMessage,
          },
        },
      ],
    });

    return {
      messages: [requestHelpResponse],
      internalMessages: [requestHelpResponse],
    };
  }

  // Create default taskPlan if not provided (when calling programmer directly without planner)
  let taskPlanToReturn: TaskPlan | undefined;
  if (!state.taskPlan) {
    taskPlanToReturn = {
      tasks: [
        {
          id: "default-task",
          taskIndex: 0,
          request: "Execute the user request",
          title: "Execute Request",
          createdAt: Date.now(),
          completed: false,
          planRevisions: [
            {
              revisionIndex: 0,
              plans: [
                {
                  index: 0,
                  plan: "Execute the user request",
                  completed: false,
                },
              ],
              createdAt: Date.now(),
              createdBy: "agent",
            },
          ],
          activeRevisionIndex: 0,
        },
      ],
      activeTaskIndex: 0,
    };
    logger.info("Created default taskPlan for direct programmer call");
  }

  const [missingMessages, { taskPlan: latestTaskPlan }] = shouldCreateIssue(
    config,
  )
    ? await Promise.all([
        getMissingMessages(state, config),
        getPlansFromIssue(state, config),
      ])
    : [[], { taskPlan: null }];

  // Generate loop warning if loop is detected (but not severe enough to force action)
  const loopWarning =
    loopDetectionResult.recommendation === "warn"
      ? generateLoopWarningPrompt(loopDetectionResult)
      : "";

  if (loopWarning) {
    logger.info("Injecting loop warning into prompt", {
      loopCount: loopDetectionResult.loopCount,
      repeatedTool: loopDetectionResult.repeatedToolCall?.name,
    });
  }

  config.writer?.({
    type: "preparing_tools",
    timestamp: Date.now(),
    message: "Preparing tools and messages for LLM",
  });

  const { providerTools, providerMessages } = await createToolsAndPrompt(
    state,
    config,
    {
      latestTaskPlan,
      missingMessages,
      loopWarning,
    },
  );

  config.writer?.({
    type: "loading_model",
    timestamp: Date.now(),
    modelName,
    task: "PROGRAMMER",
  });

  const model = await loadModel(config, LLMTask.PROGRAMMER, {
    providerTools: providerTools,
    providerMessages: providerMessages,
  });

  const isGeminiModel = modelName.includes("gemini");

  logger.error("[Gemini Debug] Model detection", {
    modelName,
    isAnthropicModel,
    isGeminiModel,
    willUseProvider: isAnthropicModel
      ? "anthropic"
      : isGeminiModel
        ? "google-genai"
        : "openai",
  });

  const modelWithTools = model.bindTools(
    isAnthropicModel ? providerTools.anthropic : providerTools.openai,
    {
      tool_choice: "auto",
      ...(modelSupportsParallelToolCallsParam
        ? {
            parallel_tool_calls: true,
          }
        : {}),
    },
  );

  const messagesToUse = isAnthropicModel
    ? providerMessages.anthropic
    : isGeminiModel
      ? providerMessages["google-genai"]
      : providerMessages.openai;

  // For FallbackRunnable, always pass anthropic messages as the base input
  // FallbackRunnable will use providerMessages to select the correct messages for each provider
  const baseMessagesForFallback = providerMessages.anthropic;

  logger.error("[Gemini Debug] Final messages to invoke", {
    messageCount: messagesToUse.length,
    baseMessagesCount: baseMessagesForFallback.length,
    willUseProviderMessages: true,
    messageSequence: messagesToUse.map((m: any, idx: number) => ({
      index: idx,
      type: m.constructor?.name || typeof m,
      role: m.role || m._getType?.(),
      hasContent: !!m.content,
      hasToolCalls: !!m.tool_calls?.length,
      toolCallsCount: m.tool_calls?.length || 0,
      isSystemMessage: m.role === "system",
    })),
  });

  logger.error(
    "[Gemini Debug] Analyzing message ordering for Gemini compatibility",
    {
      violations: messagesToUse
        .map((m: any, idx: number) => {
          if (idx === 0) return null;

          const prevMsg = messagesToUse[idx - 1] as any;
          const currentMsg = m;

          const prevType = prevMsg.constructor?.name || typeof prevMsg;
          const prevRole = prevMsg.role || prevMsg._getType?.();
          const prevHasToolCalls = !!prevMsg.tool_calls?.length;

          const currentType = currentMsg.constructor?.name || typeof currentMsg;
          const currentRole = currentMsg.role || currentMsg._getType?.();
          const currentHasToolCalls = !!currentMsg.tool_calls?.length;

          const isViolation =
            (prevHasToolCalls &&
              currentRole !== "tool" &&
              currentRole !== "function") ||
            (prevRole === "assistant" &&
              prevHasToolCalls &&
              currentRole === "user") ||
            (prevRole === "assistant" &&
              prevHasToolCalls &&
              currentRole === "system");

          if (isViolation) {
            return {
              index: idx,
              violation:
                "Gemini requires tool calls to be followed by tool/function responses",
              prevMessage: {
                index: idx - 1,
                type: prevType,
                role: prevRole,
                hasToolCalls: prevHasToolCalls,
                toolCallsCount: prevMsg.tool_calls?.length || 0,
              },
              currentMessage: {
                index: idx,
                type: currentType,
                role: currentRole,
                hasToolCalls: currentHasToolCalls,
              },
            };
          }

          return null;
        })
        .filter((v) => v !== null),
    },
  );

  config.writer?.({
    type: "invoking_model",
    timestamp: Date.now(),
    messageCount: messagesToUse.length,
    modelName,
  });

  let response: AIMessage;
  try {
    // Pass base messages - FallbackRunnable will select correct provider-specific messages
    response = await modelWithTools.invoke(baseMessagesForFallback);

    config.writer?.({
      type: "model_response",
      timestamp: Date.now(),
      hasToolCalls: !!response.tool_calls?.length,
      toolCallsCount: response.tool_calls?.length || 0,
      toolNames: response.tool_calls?.map((tc) => tc.name) || [],
    });

    logger.error("[Gemini Debug] Model invocation successful", {
      responseType: response.constructor?.name,
      hasToolCalls: !!response.tool_calls?.length,
      toolCallsCount: response.tool_calls?.length || 0,
    });
  } catch (error) {
    config.writer?.({
      type: "model_error",
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });

    logger.error("[Gemini Debug] Model invocation failed", {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "Unknown",
      errorStack:
        error instanceof Error
          ? error.stack?.split("\n").slice(0, 5)
          : undefined,
    });
    throw error;
  }

  const hasToolCalls = !!response.tool_calls?.length;
  // No tool calls means the graph is going to end. Stop the sandbox.
  let newSandboxSessionId: string | undefined;
  if (!hasToolCalls && state.sandboxSessionId) {
    config.writer?.({
      type: "stopping_sandbox",
      timestamp: Date.now(),
      reason: "no_tool_calls",
    });

    logger.info("No tool calls found. Stopping sandbox...");
    newSandboxSessionId = await stopSandbox(state.sandboxSessionId);
  }

  if (
    response.tool_calls?.length &&
    response.tool_calls?.length > 1 &&
    response.tool_calls.some((t) => t.name === markTaskCompletedTool.name)
  ) {
    logger.error(
      `Multiple tool calls found, including ${markTaskCompletedTool.name}. Removing the ${markTaskCompletedTool.name} call.`,
      {
        toolCalls: JSON.stringify(response.tool_calls, null, 2),
      },
    );
    response.tool_calls = response.tool_calls.filter(
      (t) => t.name !== markTaskCompletedTool.name,
    );
  }

  // Safe access for taskPlan - use created default or state taskPlan
  const effectiveTaskPlan = taskPlanToReturn || state.taskPlan;
  const activePlanItems = effectiveTaskPlan
    ? getActivePlanItems(effectiveTaskPlan)
    : [];
  const currentTaskPlan =
    activePlanItems.length > 0
      ? getCurrentPlanItem(activePlanItems).plan
      : "No task plan";

  config.writer?.({
    type: "action_generated",
    timestamp: Date.now(),
    currentTask: currentTaskPlan,
    hasContent: !!getMessageContentString(response.content),
    toolCalls:
      response.tool_calls?.map((tc) => ({
        name: tc.name,
        argsPreview: JSON.stringify(tc.args).substring(0, 100),
      })) || [],
  });

  logger.info("Generated action", {
    currentTask: currentTaskPlan,
    ...(getMessageContentString(response.content) && {
      content: getMessageContentString(response.content),
    }),
    ...(response.tool_calls?.map((tc) => ({
      name: tc.name,
      args: tc.args,
    })) || []),
  });

  const newMessagesList = [...missingMessages, response];
  // Return taskPlan: prioritize latestTaskPlan from issue, then created default, then nothing
  const finalTaskPlan = latestTaskPlan || taskPlanToReturn;
  return {
    messages: newMessagesList,
    internalMessages: newMessagesList,
    ...(newSandboxSessionId && { sandboxSessionId: newSandboxSessionId }),
    ...(finalTaskPlan && { taskPlan: finalTaskPlan }),
    tokenData: trackCachePerformance(response as AIMessageChunk, modelName),
  };
}
