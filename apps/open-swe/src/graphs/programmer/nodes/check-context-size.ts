import { Command } from "@langchain/langgraph";
import { GraphConfig, GraphState } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import {
    calculateConversationHistoryTokenCount,
    getMessagesSinceLastSummary,
    getCheckContextSizeTokens,
} from "../../../utils/tokens.js";
import { isRunCancelled } from "../../../utils/run-cancellation.js";
import { END } from "@langchain/langgraph";
import {
    STATIC_ANTHROPIC_SYSTEM_INSTRUCTIONS,
    DYNAMIC_SYSTEM_PROMPT,
    DEPENDENCIES_INSTALLED_PROMPT,
    DEPENDENCIES_NOT_INSTALLED_PROMPT,
} from "./generate-message/prompt.js";
import { getActivePlanItems } from "@openswe/shared/open-swe/tasks";
import { formatPlanPrompt } from "../../../utils/plan-prompt.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSkillsRepoPrompt, getSkillsFirstStep } from "../../../utils/skills-prompt.js";
import { formatCustomRulesPrompt } from "../../../utils/custom-rules.js";
import { getConfig, getConfigNumber } from "@openswe/shared/dynamic-config";

const logger = createLogger(LogLevel.INFO, "CheckContextSize");

// Token threshold for pre-action context check - use per-task function
// This is the TOTAL context limit including all overhead
// Supports per-task override: PROGRAMMER_CHECK_CONTEXT_SIZE_TOKENS
const getContextSizeThreshold = () => getCheckContextSizeTokens("programmer");

// Estimated tokens for tool definitions (~10-15K depending on tools enabled)
// Tools vary by config so we use a fixed estimate
const TOOLS_OVERHEAD_TOKENS = getConfigNumber("TOOLS_OVERHEAD_TOKENS", 12000) ?? 12000;

// Logger Hub configuration for context size monitoring
const getLoggerHubUrl = () => getConfig("LOGGER_HUB_URL") || "";
const getLoggerHubApiKey = () => getConfig("LOGGER_HUB_API_KEY") || "";
const isLoggerHubEnabled = () => getConfig("LOGGER_HUB_ENABLED") !== "false" && !!getLoggerHubUrl();

/**
 * Calculate tokens for the FULL system prompt payload.
 * Mirrors the logic in generate-message/index.ts:
 * 1. formatStaticInstructionsPrompt() - with all replacements
 * 2. formatDynamicContextPrompt() - with codebaseTree, plan, etc.
 * 3. Code review context (if present) - not counted here, optional
 * 
 * CRITICAL: state.codebaseTree can be 10-50K tokens!
 */
function calculateSystemPromptTokens(state: GraphState): number {
    // 1. Static system instructions (with all replacements as in generate-message/index.ts:132-145)
    const repoDirectory = getRepoAbsolutePath(state.targetRepository, undefined, state.sandboxProviderType);
    const staticPrompt = STATIC_ANTHROPIC_SYSTEM_INSTRUCTIONS
        .replaceAll("{REPO_DIRECTORY}", repoDirectory)
        .replaceAll("{SKILLS_REPO_PROMPT}", getSkillsRepoPrompt())
        .replaceAll("{SKILLS_REPO_FIRST_STEP}", getSkillsFirstStep())
        .replaceAll("{CUSTOM_RULES}", formatCustomRulesPrompt(state.customRules))
        .replace("{CUSTOM_FRAMEWORK_PROMPT}", "")  // Only if shouldUseCustomFramework(config)
        .replace("{DEV_SERVER_PROMPT}", "");

    const staticPromptTokens = Math.ceil(staticPrompt.length / 4);

    // 2. Dynamic context prompt (with all replacements as in generate-message/index.ts:99-125)
    const activePlanItems = state.taskPlan ? getActivePlanItems(state.taskPlan) : [];
    const planString = activePlanItems
        .map((i) => `<plan-item index="${i.index}">\n${i.plan}\n</plan-item>`)
        .join("\n");

    const dynamicPrompt = DYNAMIC_SYSTEM_PROMPT
        .replaceAll("{PLAN_PROMPT}", planString || "No plan available")
        .replaceAll("{PLAN_GENERATION_NOTES}", state.contextGatheringNotes || "No context gathering notes available.")
        .replaceAll("{REPO_DIRECTORY}", repoDirectory)
        .replaceAll("{DEPENDENCIES_INSTALLED_PROMPT}",
            state.dependenciesInstalled ? DEPENDENCIES_INSTALLED_PROMPT : DEPENDENCIES_NOT_INSTALLED_PROMPT)
        .replaceAll("{CODEBASE_TREE}", state.codebaseTree || "No codebase tree generated yet.");  // CRITICAL!

    const dynamicPromptTokens = Math.ceil(dynamicPrompt.length / 4);

    // 3. formatSpecificPlanPrompt (added as extra HumanMessage in generate-message/index.ts:346-348)
    const planSpecificPrompt = `<detailed_plan_information>
Here is the task execution plan for the request you're working on.
Ensure you carefully read through all of the instructions, messages, and context provided above.
Once you have a clear understanding of the current state of the task, analyze the plan provided below, and take an action based on it.
You're provided with the full list of tasks, including the completed, current and remaining tasks.

You are in the process of executing the current task:

${activePlanItems.length > 0 ? formatPlanPrompt(activePlanItems) : "No plan available - execute the user request directly."}
</detailed_plan_information>`;

    const planSpecificPromptTokens = Math.ceil(planSpecificPrompt.length / 4);

    const totalSystemTokens = staticPromptTokens + dynamicPromptTokens + planSpecificPromptTokens;

    logger.debug("System prompt token breakdown", {
        staticPromptTokens,
        dynamicPromptTokens,
        planSpecificPromptTokens,
        codebaseTreeLength: state.codebaseTree?.length || 0,
        codebaseTreeTokens: Math.ceil((state.codebaseTree?.length || 0) / 4),
        customRulesPresent: !!state.customRules,
        totalSystemTokens,
    });

    return totalSystemTokens;
}

/**
 * Log context size check to Logger Hub (fire-and-forget)
 * Collection: uragent-urtest-context-checks
 */
function logContextSizeCheck(data: {
    threadId: string;
    runId?: string;
    messageTokens: number;
    systemPromptTokens: number;
    toolsTokens: number;
    totalTokens: number;
    maxTokens: number;
    messageCount: number;
    messagesToCheckCount: number;
    codebaseTreeTokens: number;
    thresholdPercent: number;
    decision: "summarize-history" | "generate-action" | "cancelled";
    timestamp: number;
}): void {
    if (!isLoggerHubEnabled()) return;

    try {
        fetch(getLoggerHubUrl(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": getLoggerHubApiKey(),
            },
            body: JSON.stringify({
                collection: "uragent-urtest-context-checks",
                data,
            }),
        }).catch(() => {
            // Silently ignore errors
        });
    } catch {
        // Silently ignore errors
    }
}

/**
 * Pre-emptive check for context size before calling generate-action.
 * This prevents "Prompt is too long" errors by routing to summarize-history
 * BEFORE the API call is made.
 * 
 * FULL PAYLOAD token calculation includes:
 * - Message tokens (from internalMessages since last summary)
 * - System prompt tokens:
 *   - STATIC_ANTHROPIC_SYSTEM_INSTRUCTIONS (with replacements)
 *   - DYNAMIC_SYSTEM_PROMPT (with codebaseTree - can be HUGE!)
 *   - formatSpecificPlanPrompt (extra HumanMessage with plan)
 * - Tool definitions tokens (fixed estimate ~12K)
 * 
 * Flow:
 * - If total tokens >= getContextSizeThreshold() → route to summarize-history
 * - Otherwise → route to generate-action
 */
export async function checkContextSize(
    state: GraphState,
    config: GraphConfig,
): Promise<Command> {
    const codebaseTreeTokens = Math.ceil((state.codebaseTree?.length || 0) / 4);

    if (await isRunCancelled(config)) {
        logContextSizeCheck({
            threadId: config.configurable?.thread_id || "unknown",
            runId: config.configurable?.run_id,
            messageTokens: 0,
            systemPromptTokens: 0,
            toolsTokens: 0,
            totalTokens: 0,
            maxTokens: getContextSizeThreshold(),
            messageCount: state.internalMessages.length,
            messagesToCheckCount: 0,
            codebaseTreeTokens,
            thresholdPercent: 0,
            decision: "cancelled",
            timestamp: Date.now(),
        });

        return new Command({
            goto: END,
        });
    }

    const messagesToCheck = await getMessagesSinceLastSummary(
        state.internalMessages,
        {
            excludeHiddenMessages: true,
        },
    );

    // Calculate tokens for each component of the FULL payload
    const messageTokens = calculateConversationHistoryTokenCount(messagesToCheck, {
        excludeHiddenMessages: true,
    });
    const systemPromptTokens = calculateSystemPromptTokens(state);
    const toolsTokens = TOOLS_OVERHEAD_TOKENS;

    // Total = messages + system prompt + tools (what Anthropic actually counts)
    const totalEstimatedTokens = messageTokens + systemPromptTokens + toolsTokens;
    const thresholdPercent = Math.round((totalEstimatedTokens / getContextSizeThreshold()) * 100);

    logger.info("Pre-action context size check (FULL PAYLOAD)", {
        messageTokens,
        systemPromptTokens,
        toolsTokens,
        codebaseTreeTokens,
        totalEstimatedTokens,
        maxTokens: getContextSizeThreshold(),
        messageCount: state.internalMessages.length,
        messagesToCheckCount: messagesToCheck.length,
        thresholdPercent: `${thresholdPercent}%`,
    });

    if (totalEstimatedTokens >= getContextSizeThreshold()) {
        logger.info(
            "Context size exceeds threshold. Routing to summarize-history BEFORE generate-action.",
            {
                totalEstimatedTokens,
                maxTokens: getContextSizeThreshold(),
                threshold: `${thresholdPercent}%`,
                codebaseTreeTokens,
            },
        );

        logContextSizeCheck({
            threadId: config.configurable?.thread_id || "unknown",
            runId: config.configurable?.run_id,
            messageTokens,
            systemPromptTokens,
            toolsTokens,
            totalTokens: totalEstimatedTokens,
            maxTokens: getContextSizeThreshold(),
            messageCount: state.internalMessages.length,
            messagesToCheckCount: messagesToCheck.length,
            codebaseTreeTokens,
            thresholdPercent,
            decision: "summarize-history",
            timestamp: Date.now(),
        });

        return new Command({
            goto: "summarize-history",
        });
    }

    logContextSizeCheck({
        threadId: config.configurable?.thread_id || "unknown",
        runId: config.configurable?.run_id,
        messageTokens,
        systemPromptTokens,
        toolsTokens,
        totalTokens: totalEstimatedTokens,
        maxTokens: getContextSizeThreshold(),
        messageCount: state.internalMessages.length,
        messagesToCheckCount: messagesToCheck.length,
        codebaseTreeTokens,
        thresholdPercent,
        decision: "generate-action",
        timestamp: Date.now(),
    });

    return new Command({
        goto: "generate-action",
    });
}
