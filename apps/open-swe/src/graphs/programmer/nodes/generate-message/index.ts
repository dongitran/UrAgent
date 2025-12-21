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
  BaseMessage,
  BaseMessageLike,
  HumanMessage,
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
  const activePlanItems = state.taskPlan ? getActivePlanItems(state.taskPlan) : [];
  const planString = activePlanItems
    .map((i) => `<plan-item index="${i.index}">\n${i.plan}\n</plan-item>`)
    .join("\n");
  return DYNAMIC_SYSTEM_PROMPT.replaceAll("{PLAN_PROMPT}", planString || "No plan available")
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

const formatSpecificPlanPrompt = (taskPlan: TaskPlan | null | undefined, loopWarning: string = ""): HumanMessage => {
  const activePlanItems = taskPlan ? getActivePlanItems(taskPlan) : [];
  return new HumanMessage({
    id: uuidv4(),
    content: planSpecificPrompt
      .replace("{PLAN_PROMPT}", activePlanItems.length > 0 ? formatPlanPrompt(activePlanItems) : "No plan available - execute the user request directly.")
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

  const inputMessages = filterMessagesWithoutContent([
    ...state.internalMessages,
    ...options.missingMessages,
  ]);
  if (!inputMessages.length) {
    throw new Error("No messages to process.");
  }

  const loopWarning = options.loopWarning || "";
  const effectiveTaskPlan = options.latestTaskPlan ?? state.taskPlan;

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

  return {
    providerTools: {
      anthropic: anthropicModelTools,
      openai: nonAnthropicModelTools,
      "google-genai": nonAnthropicModelTools,
    },
    providerMessages: {
      anthropic: anthropicMessages,
      openai: nonAnthropicMessages,
      "google-genai": nonAnthropicMessages,
    },
  };
}

export async function generateAction(
  state: GraphState,
  config: GraphConfig,
): Promise<GraphUpdate> {
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
  
  // Handle based on recommendation
  if (loopDetectionResult.recommendation === "force_complete") {
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
      tool_calls: [{
        id: uuidv4(),
        name: markTaskCompletedTool.name,
        args: {
          completed_task_summary: `Task was automatically marked as completed because the agent was stuck in a ${loopDescription}, repeatedly calling "${loopDetectionResult.repeatedToolCall?.name}" ${loopDetectionResult.loopCount} times. The task appears to be complete based on the repeated verification attempts.`,
        },
      }],
    });
    
    // Need to ensure taskPlan exists for handle-completed-task node
    let taskPlanForForceComplete = state.taskPlan;
    if (!taskPlanForForceComplete) {
      taskPlanForForceComplete = {
        tasks: [{
          id: "force-completed-task",
          taskIndex: 0,
          request: "Force completed due to loop",
          title: "Force Completed Task",
          createdAt: Date.now(),
          completed: false,
          planRevisions: [{
            revisionIndex: 0,
            plans: [{
              index: 0,
              plan: "Task force-completed due to loop detection",
              completed: false,
            }],
            createdAt: Date.now(),
            createdBy: "agent",
          }],
          activeRevisionIndex: 0,
        }],
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
    const isEditLoop = loopDetectionResult.isEditLoop || loopDetectionResult.loopType === "edit_loop";
    
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
      tool_calls: [{
        id: uuidv4(),
        name: "request_human_help",
        args: {
          help_request: helpMessage,
        },
      }],
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
      tasks: [{
        id: "default-task",
        taskIndex: 0,
        request: "Execute the user request",
        title: "Execute Request",
        createdAt: Date.now(),
        completed: false,
        planRevisions: [{
          revisionIndex: 0,
          plans: [{
            index: 0,
            plan: "Execute the user request",
            completed: false,
          }],
          createdAt: Date.now(),
          createdBy: "agent",
        }],
        activeRevisionIndex: 0,
      }],
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
  const loopWarning = loopDetectionResult.recommendation === "warn"
    ? generateLoopWarningPrompt(loopDetectionResult)
    : "";

  if (loopWarning) {
    logger.info("Injecting loop warning into prompt", {
      loopCount: loopDetectionResult.loopCount,
      repeatedTool: loopDetectionResult.repeatedToolCall?.name,
    });
  }

  const { providerTools, providerMessages } = await createToolsAndPrompt(
    state,
    config,
    {
      latestTaskPlan,
      missingMessages,
      loopWarning,
    },
  );

  const model = await loadModel(config, LLMTask.PROGRAMMER, {
    providerTools: providerTools,
    providerMessages: providerMessages,
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
  const response = await modelWithTools.invoke(
    isAnthropicModel ? providerMessages.anthropic : providerMessages.openai,
  );

  const hasToolCalls = !!response.tool_calls?.length;
  // No tool calls means the graph is going to end. Stop the sandbox.
  let newSandboxSessionId: string | undefined;
  if (!hasToolCalls && state.sandboxSessionId) {
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
  const activePlanItems = effectiveTaskPlan ? getActivePlanItems(effectiveTaskPlan) : [];
  const currentTaskPlan = activePlanItems.length > 0 ? getCurrentPlanItem(activePlanItems).plan : "No task plan";
  
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
    tokenData: trackCachePerformance(response, modelName),
  };
}
