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
 * Configuration Priority:
 * 1. Per-task provider override: {TASK}_PROVIDER + {TASK}_MODEL
 * 2. Per-task model with global provider: {PROVIDER}_{TASK}_MODEL
 * 3. Fallback to hardcoded defaults
 * 
 * Per-task override examples:
 * - PLANNER_PROVIDER=anthropic + PLANNER_MODEL=claude-opus-4-5-thinking
 * - PROGRAMMER_PROVIDER=google-genai + PROGRAMMER_MODEL=gemini-3-pro
 */
const getModelDefault = (task: string, fallback: string): string => {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const taskUpper = task.toUpperCase();

  // Priority 1: Check per-task provider override
  const taskProvider = env[`${taskUpper}_PROVIDER`];
  const taskModel = env[`${taskUpper}_MODEL`];

  if (taskProvider && taskModel) {
    return `${taskProvider}:${taskModel}`;
  }

  // Priority 2: Get from global provider with per-task model
  const provider = env.LLM_PROVIDER || "openai";

  // Check for per-task model based on provider
  const providerPrefix =
    provider === "google-genai" ? "GOOGLE" : provider.toUpperCase();
  const taskEnvKey = `${providerPrefix}_${taskUpper}_MODEL`;
  const taskEnvValue = env[taskEnvKey];
  if (taskEnvValue) {
    return `${provider}:${taskEnvValue}`;
  }

  return fallback;
};

/**
 * Get task config defaults dynamically at runtime
 * This ensures env vars are read when the function is called, not at module load time
 */
export function getTaskConfigDefaults(task: LLMTask): { modelName: string; temperature: number } {
  const defaults: Record<LLMTask, { fallback: string; temperature: number }> = {
    [LLMTask.PLANNER]: { fallback: "openai:claude-4-5-sonnet", temperature: 0 },
    [LLMTask.PROGRAMMER]: { fallback: "openai:claude-4-5-sonnet", temperature: 0 },
    [LLMTask.REVIEWER]: { fallback: "openai:claude-4-5-sonnet", temperature: 0 },
    [LLMTask.ROUTER]: { fallback: "openai:claude-haiku-4.5", temperature: 0 },
    [LLMTask.SUMMARIZER]: { fallback: "openai:claude-haiku-4.5", temperature: 0 },
  };

  const config = defaults[task];
  return {
    modelName: getModelDefault(task, config.fallback),
    temperature: config.temperature,
  };
}

/**
 * @deprecated Use getTaskConfigDefaults(task) instead for runtime env var evaluation
 * This static map is kept for backward compatibility but may have stale values
 */
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
