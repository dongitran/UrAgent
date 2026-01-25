import { GraphConfig } from "@openswe/shared/open-swe/types";
import { getGitHubTokensFromConfig } from "../github-tokens.js";
import {
  createIssueComment,
  getIssueComments,
  updateIssueComment,
} from "./api.js";
import { createLogger, LogLevel } from "../logger.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropicFiltered } from "../llms/anthropic/chat-anthropic-filtered.js";
import { HumanMessage } from "@langchain/core/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logAIMessage, summarizeResponse, extractTokenUsage } from "@openswe/shared/logger-hub-client";
import { getGoogleApiKeyManager } from "../llms/google-api-key-manager.js";
import { getConfig } from "@openswe/shared/dynamic-config";

const logger = createLogger(LogLevel.INFO, "GitHubPlan");

const PLAN_MESSAGE_OPEN_TAG = "<open-swe-plan-message>";
const PLAN_MESSAGE_CLOSE_TAG = "</open-swe-plan-message>";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000; // 2 seconds

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the summarizer model configuration from environment
 */
function getSummarizerModelConfig(): { provider: string; modelName: string } {
  const provider = getConfig("LLM_PROVIDER") || "openai";
  const providerPrefix = provider === "google-genai" ? "GOOGLE" : provider.toUpperCase();
  const taskEnvKey = `${providerPrefix}_SUMMARIZER_MODEL`;
  const taskEnvValue = getConfig(taskEnvKey);

  if (taskEnvValue) {
    return { provider, modelName: taskEnvValue };
  }

  // Fallback defaults based on provider
  const defaultModels: Record<string, string> = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-20241022",
    "google-genai": "gemini-2.0-flash",
  };

  return {
    provider,
    modelName: defaultModels[provider] || "gpt-4o-mini"
  };
}

/**
 * Get API key for provider
 */
function getApiKeyForProvider(provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return getConfig("OPENAI_API_KEY");
    case "anthropic":
      return getConfig("ANTHROPIC_API_KEY");
    case "google-genai":
      return getGoogleApiKeyManager().getNextKey();
    default:
      return undefined;
  }
}

/**
 * Call Google Generative AI directly (bypass LangChain wrapper)
 */
async function callGoogleGenAI(modelName: string, apiKey: string, prompt: string): Promise<string> {
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return text.trim();
}

/**
 * Call LLM with proper provider handling
 * For Google GenAI, uses the native SDK directly to avoid LangChain wrapper issues
 */
async function callLLM(prompt: string): Promise<string> {
  const { provider, modelName } = getSummarizerModelConfig();
  const apiKey = getApiKeyForProvider(provider);

  if (!apiKey) {
    throw new Error(`API key not set for provider ${provider}`);
  }

  const startTime = Date.now();

  try {
    let text: string;
    let response: any;

    if (provider === "google-genai") {
      // Use Google Generative AI SDK directly to avoid LangChain wrapper issues
      text = await callGoogleGenAI(modelName, apiKey, prompt);

      // Log to Logger Hub (fire and forget)
      const durationMs = Date.now() - startTime;
      logAIMessage({
        threadId: 'github-plan-generator',
        provider,
        modelName,
        task: 'PLAN_GENERATOR',
        status: 'success',
        requestMessages: [{ role: 'human', content: prompt }],
        response: { content: text },
        durationMs,
        timestamp: Date.now(),
      });

      return text;
    } else if (provider === "openai") {
      const model = new ChatOpenAI({
        modelName,
        apiKey,
        temperature: 0.8,
        maxTokens: 5000,
        ...(getConfig("OPENAI_BASE_URL") ? { configuration: { baseURL: getConfig("OPENAI_BASE_URL") } } : {}),
      });
      response = await model.invoke([new HumanMessage(prompt)]);
      text = typeof response.content === 'string'
        ? response.content.trim()
        : Array.isArray(response.content)
          ? response.content.map((c: unknown) => typeof c === 'string' ? c : '').join('').trim()
          : '';

      // Log to Logger Hub (fire and forget)
      const durationMs = Date.now() - startTime;
      logAIMessage({
        threadId: 'github-plan-generator',
        provider,
        modelName,
        task: 'PLAN_GENERATOR',
        status: 'success',
        requestMessages: [{ role: 'human', content: prompt }],
        response: summarizeResponse(response),
        durationMs,
        tokenUsage: extractTokenUsage(response),
        timestamp: Date.now(),
      });

      return text;
    } else if (provider === "anthropic") {
      const model = new ChatAnthropicFiltered({
        modelName,
        apiKey,
        temperature: 0.8,
        maxTokens: 5000,
      });
      response = await model.invoke([new HumanMessage(prompt)]);
      text = typeof response.content === 'string'
        ? response.content.trim()
        : Array.isArray(response.content)
          ? response.content.map((c: unknown) => typeof c === 'string' ? c : '').join('').trim()
          : '';

      // Log to Logger Hub (fire and forget)
      const durationMs = Date.now() - startTime;
      logAIMessage({
        threadId: 'github-plan-generator',
        provider,
        modelName,
        task: 'PLAN_GENERATOR',
        status: 'success',
        requestMessages: [{ role: 'human', content: prompt }],
        response: summarizeResponse(response),
        durationMs,
        tokenUsage: extractTokenUsage(response),
        timestamp: Date.now(),
      });

      return text;
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (error) {
    // Log error to Logger Hub (fire and forget)
    const durationMs = Date.now() - startTime;
    const errorDetails = error instanceof Error
      ? { message: error.message, name: error.name }
      : { message: String(error) };
    logAIMessage({
      threadId: 'github-plan-generator',
      provider,
      modelName,
      task: 'PLAN_GENERATOR',
      status: 'error',
      requestMessages: [{ role: 'human', content: prompt }],
      durationMs,
      error: errorDetails,
      timestamp: Date.now(),
    });
    throw error;
  }
}

/**
 * Check if an error is retryable (network, timeout, rate limit, server errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    // Network/timeout errors
    if (message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket') ||
      message.includes('fetch failed') ||
      name.includes('timeout') ||
      name.includes('abort')) {
      return true;
    }

    // Rate limit or server errors (check for status codes in message)
    if (message.includes('429') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('rate limit')) {
      return true;
    }
  }

  return false;
}

function formatBodyWithPlanMessage(body: string, message: string): string {
  if (
    body.includes(PLAN_MESSAGE_OPEN_TAG) &&
    body.includes(PLAN_MESSAGE_CLOSE_TAG)
  ) {
    const bodyBeforeTag = body.split(PLAN_MESSAGE_OPEN_TAG)[0];
    const bodyAfterTag = body.split(PLAN_MESSAGE_CLOSE_TAG)[1];
    const newInnerContents = `\n${PLAN_MESSAGE_OPEN_TAG}\n\n${message}\n\n${PLAN_MESSAGE_CLOSE_TAG}\n`;
    return `${bodyBeforeTag}${newInnerContents}${bodyAfterTag}`;
  }

  return `${body}\n${PLAN_MESSAGE_OPEN_TAG}\n\n${message}\n\n${PLAN_MESSAGE_CLOSE_TAG}`;
}

export function cleanTaskItems(taskItem: string): string {
  return "```\n" + taskItem.replace("```", "\\```") + "\n```";
}

/**
 * Message types for generating natural GitHub comments
 */
export type GitHubCommentType =
  | "plan_generated_auto_accept"
  | "plan_ready_for_approval"
  | "plan_accepted"
  | "plan_edited"
  | "implementation_complete";

/**
 * Context for generating natural GitHub comments
 */
export interface GitHubCommentContext {
  type: GitHubCommentType;
  planTitle?: string;
  planSteps?: string[];
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  tasksCompleted?: number;
  totalTasks?: number;
  prAction?: "created" | "updated";
  // Issue context for language detection
  issueTitle?: string;
  issueBody?: string;
}

/**
 * Generates a natural-sounding GitHub comment using LLM
 * Responds in the same language as the issue content
 * Retries up to 3 times on retryable errors
 */
export async function generateNaturalComment(
  context: GitHubCommentContext,
): Promise<string> {
  const fallbackMessages: Record<GitHubCommentType, string> = {
    plan_generated_auto_accept: `🤖 I've analyzed the issue and created a plan. Since auto-accept is enabled, I'll start implementing right away!\n\n**Plan: ${context.planTitle}**\n\n${context.planSteps?.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\nStarting implementation...`,
    plan_ready_for_approval: `🟠 I've created a plan for this issue! Take a look and let me know if it looks good.\n\n**Plan: ${context.planTitle}**\n\n${context.planSteps?.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\nWaiting for your approval to proceed.`,
    plan_accepted: `✅ Great, plan approved! I'll get started on the implementation now.\n\n**Plan: ${context.planTitle}**\n\n${context.planSteps?.map((step, i) => `${i + 1}. ${step}`).join("\n")}`,
    plan_edited: `✅ Got it, I'll use the edited plan. Starting implementation now!\n\n**Plan: ${context.planTitle}**\n\n${context.planSteps?.map((step, i) => `${i + 1}. ${step}`).join("\n")}`,
    implementation_complete: `✅ All done! I've ${context.prAction} PR [#${context.prNumber}](${context.prUrl}) with the changes. Ready for your review!`,
  };

  // Build issue context for language detection - placed at the top of prompt for emphasis
  const issueContextBlock = context.issueTitle || context.issueBody
    ? `Title: "${context.issueTitle || ''}"
Body: "${(context.issueBody || '').slice(0, 300)}${(context.issueBody || '').length > 300 ? '...' : ''}"`
    : 'No issue content provided - default to English';

  const planStepsFormatted = context.planSteps?.map((step, i) => `${i + 1}. ${step}`).join("\n") || '';

  // Language rule block - placed at the very top of each prompt
  const languageRuleBlock = `## ⚠️ CRITICAL: LANGUAGE RULE (READ FIRST)
Your response MUST be in the SAME LANGUAGE as the original issue below.
- If issue is in Vietnamese → respond in Vietnamese (e.g., "Mình đã lên plan...")
- If issue is in English → respond in English (e.g., "I've created a plan...")

ORIGINAL ISSUE:
${issueContextBlock}`;

  // Reminder at the end of each prompt
  const languageReminder = `⚠️ REMINDER: Your response MUST be in the same language as the original issue above!`;

  const prompts: Record<GitHubCommentType, string> = {
    plan_generated_auto_accept: `${languageRuleBlock}

## TASK
Generate a GitHub comment announcing that you've created a plan and will start implementing immediately (auto-accept mode).

## DATA
Plan title: ${context.planTitle}
Plan steps:
${planStepsFormatted}

## OUTPUT FORMAT
- Start with an emoji (🚀, 🤖, 💪, etc.)
- 2-3 sentences intro
- Then list the plan steps as numbered list
- Mention you're starting implementation now
- Casual tone, like chatting with a coworker
- Use markdown

## EXAMPLES
Vietnamese: "🚀 Mình đã phân tích issue và lên plan rồi nha! Vì auto-accept nên mình sẽ bắt đầu implement luôn..."
English: "🚀 I've analyzed the issue and created a plan! Since auto-accept is enabled, I'll start implementing right away..."

${languageReminder}
Respond with ONLY the comment text.`,

    plan_ready_for_approval: `${languageRuleBlock}

## TASK
Generate a GitHub comment presenting a plan and asking for user approval.

## DATA
Plan title: ${context.planTitle}
Plan steps:
${planStepsFormatted}

## OUTPUT FORMAT
- Start with an emoji (🟠, 📋, 👀, etc.)
- 2-3 sentences intro
- Then list the plan steps as numbered list
- Ask for approval/feedback casually
- Casual tone, like chatting with a coworker
- Use markdown

## EXAMPLES
Vietnamese: "🟠 Mình đã lên plan cho issue này rồi! Bạn xem qua giúp mình nhé..."
English: "🟠 I've put together a plan for this issue! Take a look and let me know what you think..."

${languageReminder}
Respond with ONLY the comment text.`,

    plan_accepted: `${languageRuleBlock}

## TASK
Generate a GitHub comment confirming plan approval and announcing implementation start.

## DATA
Plan title: ${context.planTitle}
Plan steps:
${planStepsFormatted}

## OUTPUT FORMAT
- Start with ✅ or similar positive emoji
- 1-2 sentences acknowledging approval
- Then list the plan steps as numbered list
- Mention starting implementation
- Enthusiastic but casual tone
- Use markdown

## EXAMPLES
Vietnamese: "✅ Ngon! Mình sẽ bắt đầu implement theo plan này nha..."
English: "✅ Great! I'll start implementing this plan now..."

${languageReminder}
Respond with ONLY the comment text.`,

    plan_edited: `${languageRuleBlock}

## TASK
Generate a GitHub comment acknowledging plan edits and announcing implementation start.

## DATA
Plan title: ${context.planTitle}
Plan steps (edited):
${planStepsFormatted}

## OUTPUT FORMAT
- Start with ✅ or similar positive emoji
- 1-2 sentences acknowledging the edits positively
- Then list the edited plan steps as numbered list
- Mention starting implementation
- Casual tone
- Use markdown

## EXAMPLES
Vietnamese: "✅ Ok, mình sẽ dùng plan đã chỉnh sửa nha! Bắt đầu implement thôi..."
English: "✅ Got it! I'll use the edited plan. Starting implementation now..."

${languageReminder}
Respond with ONLY the comment text.`,

    implementation_complete: `${languageRuleBlock}

## TASK
Generate a GitHub comment announcing that implementation is complete and PR is ready for review.

## DATA
PR number: #${context.prNumber}
PR title: ${context.prTitle}
PR URL: ${context.prUrl}
Action: ${context.prAction} (created or updated)
Tasks completed: ${context.tasksCompleted}/${context.totalTasks}

## OUTPUT FORMAT
- Start with ✅ or 🎉 emoji
- 2-3 sentences max
- Include PR link as markdown: [#${context.prNumber}](${context.prUrl})
- Mention ready for review
- Casual, friendly tone

## EXAMPLES
Vietnamese: "🎉 Xong rồi! Mình đã tạo PR [#${context.prNumber}](${context.prUrl}) với các thay đổi. Bạn review giúp mình nhé!"
English: "🎉 All done! I've created PR [#${context.prNumber}](${context.prUrl}) with the changes. Ready for your review!"

${languageReminder}
Respond with ONLY the comment text.`,
  };

  let lastError: Error | undefined;
  const { provider, modelName } = getSummarizerModelConfig();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const generatedMessage = await callLLM(prompts[context.type]);

      const trimmedMessage = generatedMessage.trim();
      if (trimmedMessage && trimmedMessage.length > 0) {
        return trimmedMessage;
      }

      lastError = new Error("Empty response from LLM");
      logger.warn("[generateNaturalComment] Empty response, will retry", {
        attempt: attempt + 1,
        type: context.type,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn(`[generateNaturalComment] Attempt ${attempt + 1}/${MAX_RETRIES} failed`, {
        error: lastError.message,
        errorName: lastError.name,
        type: context.type,
        provider,
        modelName,
      });

      if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`generateNaturalComment retrying in ${delay}ms`, {
          error: lastError.message,
          type: context.type,
        });
        await sleep(delay);
        continue;
      }

      logger.warn("Failed to generate natural comment with LLM, using fallback", {
        error: lastError.message,
        type: context.type,
        attempt: attempt + 1,
      });
      return fallbackMessages[context.type];
    }

    // Wait before retry for empty response
    if (attempt < MAX_RETRIES - 1) {
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  logger.warn("Failed to generate natural comment after all retries, using fallback", {
    error: lastError?.message,
    type: context.type,
    provider,
    modelName,
  });
  return fallbackMessages[context.type];
}

/**
 * Posts a comment to a GitHub issue using the installation token
 * Retries up to 3 times on retryable errors
 */
export async function postGitHubIssueComment(input: {
  githubIssueId: number;
  targetRepository: { owner: string; repo: string };
  commentBody: string;
  config: GraphConfig;
}): Promise<void> {
  const { githubIssueId, targetRepository, commentBody, config } = input;

  if (isLocalMode(config)) {
    // In local mode, we don't post GitHub comments
    logger.info("Skipping GitHub comment posting in local mode");
    return;
  }

  const githubAppName = process.env.GITHUB_APP_NAME;
  if (!githubAppName) {
    throw new Error("GITHUB_APP_NAME not set");
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { githubInstallationToken } = await getGitHubTokensFromConfig(config);
      const existingComments = await getIssueComments({
        owner: targetRepository.owner,
        repo: targetRepository.repo,
        issueNumber: githubIssueId,
        githubInstallationToken,
        filterBotComments: false,
      });

      const existingOpenSWEComment = existingComments?.findLast((c) =>
        c.user?.login?.toLowerCase()?.startsWith(githubAppName.toLowerCase()),
      );

      if (!existingOpenSWEComment) {
        await createIssueComment({
          owner: targetRepository.owner,
          repo: targetRepository.repo,
          issueNumber: githubIssueId,
          body: commentBody,
          githubToken: githubInstallationToken,
        });

        logger.info(`Posted comment to GitHub issue #${githubIssueId}`);
        return;
      }

      // Update the comment
      const newCommentBody = formatBodyWithPlanMessage(
        existingOpenSWEComment.body ?? "",
        commentBody,
      );
      await updateIssueComment({
        owner: targetRepository.owner,
        repo: targetRepository.repo,
        commentId: existingOpenSWEComment.id,
        body: newCommentBody,
        githubInstallationToken,
      });

      logger.info(`Updated comment to GitHub issue #${githubIssueId}`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`postGitHubIssueComment attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${delay}ms`, {
          error: lastError.message,
          githubIssueId,
        });
        await sleep(delay);
        continue;
      }

      logger.error("Failed to post GitHub comment:", {
        error: lastError.message,
        githubIssueId,
        attempt: attempt + 1,
      });
      // Don't throw - we don't want to fail the entire process if comment posting fails
      return;
    }
  }
}
