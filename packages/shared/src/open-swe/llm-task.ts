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
// Priority: OPENAI_*_MODEL (for LiteLLM) > ANTHROPIC_*_MODEL > hardcoded defaults
const getModelDefault = (task: string, fallback: string): string => {
  // First check for OpenAI models (LiteLLM gateway)
  const openaiEnvKey = `OPENAI_${task.toUpperCase()}_MODEL`;
  const openaiEnvValue = typeof process !== 'undefined' && process.env ? process.env[openaiEnvKey] : undefined;
  if (openaiEnvValue) {
    return `openai:${openaiEnvValue}`;
  }
  
  // Then check for Anthropic models
  const anthropicEnvKey = `ANTHROPIC_${task.toUpperCase()}_MODEL`;
  const anthropicEnvValue = typeof process !== 'undefined' && process.env ? process.env[anthropicEnvKey] : undefined;
  if (anthropicEnvValue) {
    return `anthropic:${anthropicEnvValue}`;
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
