import { GraphConfig } from "@openswe/shared/open-swe/types";
import { getModelManager, Provider } from "./model-manager.js";
import { FallbackRunnable } from "../runtime-fallback.js";
import { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseMessageLike } from "@langchain/core/messages";
import {
  LLMTask,
  TASK_TO_CONFIG_DEFAULTS_MAP,
} from "@openswe/shared/open-swe/llm-task";
import { createLogger, LogLevel } from "../logger.js";

const logger = createLogger(LogLevel.DEBUG, "LoadModel");

export async function loadModel(
  config: GraphConfig,
  task: LLMTask,
  options?: {
    providerTools?: Record<Provider, BindToolsInput[]>;
    providerMessages?: Record<Provider, BaseMessageLike[]>;
  },
) {
  const modelManager = getModelManager();

  logger.error("[Gemini Debug] loadModel: Starting", {
    task,
    hasProviderTools: !!options?.providerTools,
    hasProviderMessages: !!options?.providerMessages,
    providerToolsKeys: options?.providerTools ? Object.keys(options.providerTools) : [],
  });

  const model = await modelManager.loadModel(config, task);
  if (!model) {
    throw new Error(`Model loading returned undefined for task: ${task}`);
  }

  logger.error("[Gemini Debug] loadModel: Model loaded from manager", {
    task,
    modelType: model?.constructor?.name,
    modelLlmType: (model as any)?._llmType?.(),
  });

  const fallbackModel = new FallbackRunnable(
    model,
    config,
    task,
    modelManager,
    options,
  );

  logger.error("[Gemini Debug] loadModel: FallbackRunnable created", {
    task,
    fallbackModelType: fallbackModel?.constructor?.name,
    primaryRunnableType: (fallbackModel as any)?.primaryRunnable?.constructor?.name,
  });

  return fallbackModel;
}

export const MODELS_NO_PARALLEL_TOOL_CALLING = ["openai:o3", "openai:o3-mini"];

export function supportsParallelToolCallsParam(
  config: GraphConfig,
  task: LLMTask,
): boolean {
  const modelStr =
    config.configurable?.[`${task}ModelName`] ??
    TASK_TO_CONFIG_DEFAULTS_MAP[task].modelName;

  return !MODELS_NO_PARALLEL_TOOL_CALLING.some((model) => modelStr === model);
}
