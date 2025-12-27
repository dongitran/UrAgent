export enum LLMTask {
  /**
   * Used for programmer tasks. This includes: writing code,
   * generating plans, taking context gathering actions, etc.
   */
  PLANNER = "planner",
  /**
   * Used for programmer tasks. This includes: writing code,
   * generating plans, taking context gathering actions, etc.
   */
  PROGRAMMER = "programmer",
  /**
   * Used for routing tasks. This includes: initial request
   * routing to different agents.
   */
  ROUTER = "router",
  /**
   * Used for reviewer tasks. This includes: reviewing code,
   * generating plans, taking context gathering actions, etc.
   */
  REVIEWER = "reviewer",
  /**
   * Used for summarizing tasks. This includes: summarizing
   * the conversation history, summarizing actions taken during
   * a task execution, etc. Should be a slightly advanced model.
   */
  SUMMARIZER = "summarizer",
}

/**
 * Get model configuration from environment variables
 *
 * Configuration:
 * - LLM_PROVIDER: Provider to use (default: "openai" for LiteLLM gateway)
 * - {PROVIDER}_{TASK}_MODEL: Per-task models (e.g., OPENAI_PLANNER_MODEL)
 *
 * Priority:
 * 1. {PROVIDER}_{TASK}_MODEL (per-task models based on LLM_PROVIDER)
 * 2. Fallback to hardcoded defaults
 */
const getModelDefault = (task: string, fallback: string): string => {
  const env = typeof process !== "undefined" && process.env ? process.env : {};

  // Get provider
  const provider = env.LLM_PROVIDER || "openai";

  // Check for per-task model based on provider
  const providerPrefix =
    provider === "google-genai" ? "GOOGLE" : provider.toUpperCase();
  const taskEnvKey = `${providerPrefix}_${task.toUpperCase()}_MODEL`;
  const taskEnvValue = env[taskEnvKey];
  if (taskEnvValue) {
    return `${provider}:${taskEnvValue}`;
  }

  return fallback;
};

export const TASK_TO_CONFIG_DEFAULTS_MAP = {
  [LLMTask.PLANNER]: {
    modelName: getModelDefault("planner", "openai:claude-4-5-sonnet"),
    temperature: 0,
  },
  [LLMTask.PROGRAMMER]: {
    modelName: getModelDefault("programmer", "openai:claude-4-5-sonnet"),
    temperature: 0,
  },
  [LLMTask.REVIEWER]: {
    modelName: getModelDefault("reviewer", "openai:claude-4-5-sonnet"),
    temperature: 0,
  },
  [LLMTask.ROUTER]: {
    modelName: getModelDefault("router", "openai:claude-haiku-4.5"),
    temperature: 0,
  },
  [LLMTask.SUMMARIZER]: {
    modelName: getModelDefault("summarizer", "openai:claude-haiku-4.5"),
    temperature: 0,
  },
};
