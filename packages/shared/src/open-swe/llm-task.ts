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

// Model defaults - read from env or use hardcoded defaults
// Env format: ANTHROPIC_PLANNER_MODEL=claude-sonnet-4-5-20250929
const getModelDefault = (task: string, fallback: string): string => {
  const envKey = `ANTHROPIC_${task.toUpperCase()}_MODEL`;
  const envValue = typeof process !== 'undefined' && process.env ? process.env[envKey] : undefined;
  if (envValue) {
    return `anthropic:${envValue}`;
  }
  return fallback;
};

export const TASK_TO_CONFIG_DEFAULTS_MAP = {
  [LLMTask.PLANNER]: {
    modelName: getModelDefault("planner", "anthropic:claude-sonnet-4-5-20250929"),
    temperature: 0,
  },
  [LLMTask.PROGRAMMER]: {
    modelName: getModelDefault("programmer", "anthropic:claude-sonnet-4-5-20250929"),
    temperature: 0,
  },
  [LLMTask.REVIEWER]: {
    modelName: getModelDefault("reviewer", "anthropic:claude-sonnet-4-5-20250929"),
    temperature: 0,
  },
  [LLMTask.ROUTER]: {
    modelName: getModelDefault("router", "anthropic:claude-haiku-4-5-20251001"),
    temperature: 0,
  },
  [LLMTask.SUMMARIZER]: {
    modelName: getModelDefault("summarizer", "anthropic:claude-haiku-4-5-20251001"),
    temperature: 0,
  },
};
