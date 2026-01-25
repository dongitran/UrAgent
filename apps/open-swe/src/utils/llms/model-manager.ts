import {
  ConfigurableModel,
  initChatModel,
} from "langchain/chat_models/universal";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../logger.js";
import {
  LLMTask,
  getTaskConfigDefaults,
} from "@openswe/shared/open-swe/llm-task";
import { isAllowedUser } from "@openswe/shared/github/allowed-users";
import { decryptSecret } from "@openswe/shared/crypto";
import { API_KEY_REQUIRED_MESSAGE } from "@openswe/shared/constants";
import { ChatGoogleGenAI, ThinkingConfig } from "./google-genai/index.js";
import { ChatAnthropicFiltered } from "./anthropic/chat-anthropic-filtered.js";
import { getGoogleApiKeyManager } from "./google-api-key-manager.js";

const logger = createLogger(LogLevel.INFO, "ModelManager");

type InitChatModelArgs = Parameters<typeof initChatModel>[1];

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  openedAt?: number;
}

interface ModelLoadConfig {
  provider: Provider;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  thinkingModel?: boolean;
  thinkingBudgetTokens?: number;
}

export enum CircuitState {
  /*
   * CLOSED: Normal operation
   */
  CLOSED = "CLOSED",
  /*
   * OPEN: Failing, use fallback
   */
  OPEN = "OPEN",
}

export const PROVIDER_FALLBACK_ORDER = [
  "openai",
  "anthropic",
  "google-genai",
] as const;
export type Provider = (typeof PROVIDER_FALLBACK_ORDER)[number];

// Default fallback order if LLM_FALLBACK_ORDER env is not set
const DEFAULT_FALLBACK_ORDER: Provider[] = ["anthropic", "google-genai"];

/**
 * Parse LLM_FALLBACK_ORDER from environment variable
 * Format: comma-separated provider names, e.g., "anthropic,google-genai"
 */
function parseActiveFallbackOrder(): Provider[] {
  const envValue = process.env.LLM_FALLBACK_ORDER;
  if (!envValue) {
    return DEFAULT_FALLBACK_ORDER;
  }

  const providers = envValue.split(",").map(p => p.trim()) as Provider[];
  // Validate providers
  const validProviders = providers.filter(p =>
    PROVIDER_FALLBACK_ORDER.includes(p as typeof PROVIDER_FALLBACK_ORDER[number])
  );

  if (validProviders.length === 0) {
    logger.warn(`Invalid LLM_FALLBACK_ORDER: ${envValue}, using default`);
    return DEFAULT_FALLBACK_ORDER;
  }

  return validProviders;
}

/**
 * Get fallback order based on LLM_MULTI_PROVIDER_ENABLED
 * When disabled, only use the configured LLM_PROVIDER (no fallback to other providers)
 * When enabled, uses LLM_FALLBACK_ORDER env (default: anthropic -> google-genai)
 */
function getFallbackOrder(): Provider[] {
  const multiProviderEnabled =
    process.env.LLM_MULTI_PROVIDER_ENABLED === "true";

  if (multiProviderEnabled) {
    // Multi-provider mode: use configured fallback order
    return parseActiveFallbackOrder();
  }

  // Single provider mode: only use the configured provider
  const provider = (process.env.LLM_PROVIDER || "anthropic") as Provider;
  return [provider];
}

export interface ModelManagerConfig {
  /*
   * Failures before opening circuit
   */
  circuitBreakerFailureThreshold: number;
  /*
   * Time to wait before trying again (ms)
   */
  circuitBreakerTimeoutMs: number;
  fallbackOrder: Provider[];
}

export const DEFAULT_MODEL_MANAGER_CONFIG: ModelManagerConfig = {
  circuitBreakerFailureThreshold: 2, // TBD, need to test
  circuitBreakerTimeoutMs: 180000, // 3 minutes timeout
  fallbackOrder: getFallbackOrder(),
};

const MAX_RETRIES = 3;
const THINKING_BUDGET_TOKENS = 10000;

const providerToApiKey = (
  providerName: string,
  apiKeys: Record<string, string>,
): string => {
  switch (providerName) {
    case "openai":
      return apiKeys.openaiApiKey;
    case "anthropic":
      return apiKeys.anthropicApiKey;
    case "google-genai":
      return apiKeys.googleApiKey;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
};

export class ModelManager {
  private config: ModelManagerConfig;
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();

  constructor(config: Partial<ModelManagerConfig> = {}) {
    this.config = { ...DEFAULT_MODEL_MANAGER_CONFIG, ...config };

    logger.info("Initialized", {
      config: this.config,
      fallbackOrder: this.config.fallbackOrder,
    });
  }

  /**
   * Load a single model (no fallback during loading)
   * Uses per-task provider configuration via getBaseConfigForTask
   */
  async loadModel(graphConfig: GraphConfig, task: LLMTask) {
    const baseConfig = this.getBaseConfigForTask(graphConfig, task);
    const model = await this.initializeModel(baseConfig, graphConfig, task);
    return model;
  }

  private getUserApiKey(
    graphConfig: GraphConfig,
    provider: Provider,
  ): string | null {
    // Try LangGraph Cloud format first, then fall back to self-hosted header, then default config
    const userLogin =
      (graphConfig.configurable as any)?.langgraph_auth_user?.display_name ||
      (graphConfig.configurable as any)?.["x-github-user-login"] ||
      process.env.DEFAULT_GITHUB_INSTALLATION_NAME;
    const secretsEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;

    if (!secretsEncryptionKey) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEY environment variable is required",
      );
    }
    if (!userLogin) {
      throw new Error("User login not found in config");
    }

    // If the user is allowed, we can return early
    if (isAllowedUser(userLogin)) {
      return null;
    }

    const apiKeys = graphConfig.configurable?.apiKeys;
    if (!apiKeys) {
      throw new Error(API_KEY_REQUIRED_MESSAGE);
    }

    const missingProviderKeyMessage = `No API key found for provider: ${provider}. Please add one in the settings page.`;

    const providerApiKey = providerToApiKey(provider, apiKeys);
    if (!providerApiKey) {
      throw new Error(missingProviderKeyMessage);
    }

    const apiKey = decryptSecret(providerApiKey, secretsEncryptionKey);
    if (!apiKey) {
      throw new Error(missingProviderKeyMessage);
    }

    return apiKey;
  }

  /**
   * Get per-task specific configuration from environment variables
   * Supports: {TASK}_PROVIDER, {TASK}_API_KEY, {TASK}_BASE_URL
   * 
   * Example: PLANNER_PROVIDER=anthropic, PLANNER_API_KEY=sk-xxx, PLANNER_BASE_URL=https://...
   * 
   * @returns null if no per-task override is configured
   */
  private getTaskSpecificConfig(task: LLMTask): {
    provider: Provider;
    apiKey?: string;
    baseUrl?: string;
  } | null {
    const taskUpper = task.toUpperCase();
    const taskProvider = process.env[`${taskUpper}_PROVIDER`] as Provider | undefined;

    if (!taskProvider) return null;

    return {
      provider: taskProvider,
      apiKey: process.env[`${taskUpper}_API_KEY`],
      baseUrl: process.env[`${taskUpper}_BASE_URL`],
    };
  }

  /**
   * Initialize the model instance
   * For google-genai provider, uses custom ChatGoogleGenAI with thought signature support
   * 
   * @param task - Optional task parameter for checking notetaker override
   *               (override only applies when task === SUMMARIZER)
   */
  public async initializeModel(
    config: ModelLoadConfig,
    graphConfig: GraphConfig,
    task?: LLMTask,
  ) {
    const {
      provider,
      modelName,
      temperature,
      maxTokens,
      thinkingModel,
      thinkingBudgetTokens,
    } = config;

    const thinkingMaxTokens = thinkingBudgetTokens
      ? thinkingBudgetTokens * 4
      : undefined;

    let finalMaxTokens = maxTokens ?? 10_000;
    if (modelName.includes("claude-3-5-haiku")) {
      finalMaxTokens = finalMaxTokens > 8_192 ? 8_192 : finalMaxTokens;
    }

    const apiKey = this.getUserApiKey(graphConfig, provider);

    // =========================================================================
    // Get per-task specific configuration (API key, base URL)
    // This allows different tasks to use different credentials
    // =========================================================================
    const taskConfig = task ? this.getTaskSpecificConfig(task) : null;

    if (taskConfig) {
      logger.info("Using per-task provider configuration", {
        task,
        provider: taskConfig.provider,
        hasApiKey: !!taskConfig.apiKey,
        hasBaseUrl: !!taskConfig.baseUrl,
      });
    }

    // =========================================================================
    // Use custom ChatGoogleGenAI for google-genai provider
    // This properly handles Gemini 3's thought signatures for function calling
    // =========================================================================
    if (provider === "google-genai") {
      // Determine if this is a Gemini 3 model that supports thinkingConfig
      const isGemini3 = modelName.includes("gemini-3");
      const isGemini25 = modelName.includes("gemini-2.5") || modelName.includes("gemini-2-5");

      // Build thinkingConfig for Gemini 3 and 2.5 models
      // - includeThoughts: true - to see reasoning/thought summaries in response
      // - thinkingLevel: for Gemini 3 models (minimal, low, medium, high)
      // - thinkingBudget: for Gemini 2.5 models (number of tokens)
      let thinkingConfig: ThinkingConfig | undefined;

      if (isGemini3) {
        // Gemini 3 uses thinkingLevel (default is "high" for dynamic thinking)
        // Set includeThoughts: true to see thought summaries
        thinkingConfig = {
          includeThoughts: true,
          // thinkingLevel: "medium", // Can be: minimal, low, medium, high (default: high)
        };
        logger.info("Gemini 3 model detected, enabling thought summaries", {
          modelName,
          thinkingConfig,
        });
      } else if (isGemini25) {
        // Gemini 2.5 uses thinkingBudget (number of tokens)
        // -1 = dynamic thinking (model decides)
        // 0 = disable thinking
        // 128-32768 for Pro, 0-24576 for Flash
        thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: thinkingBudgetTokens || -1, // -1 for dynamic thinking
        };
        logger.info("Gemini 2.5 model detected, enabling thought summaries", {
          modelName,
          thinkingConfig,
        });
      }

      // Use per-task API key if available, otherwise use key rotation
      const googleApiKey = (taskConfig?.provider === "google-genai" ? taskConfig.apiKey : null)
        || apiKey
        || getGoogleApiKeyManager().getNextKey();

      logger.info("Using custom ChatGoogleGenAI with thought signature support", {
        modelName,
        hasApiKey: !!googleApiKey,
        isGemini3,
        isGemini25,
        hasThinkingConfig: !!thinkingConfig,
        usingTaskConfig: taskConfig?.provider === "google-genai",
      });

      const googleModel = new ChatGoogleGenAI({
        model: modelName,
        apiKey: googleApiKey,
        temperature: thinkingModel ? undefined : temperature,
        maxOutputTokens: finalMaxTokens,
        thinkingConfig: thinkingConfig,
      });

      return googleModel as unknown as ConfigurableModel;
    }

    // =========================================================================
    // Use custom ChatAnthropicFiltered for Anthropic provider
    // This properly filters out top_k: -1 and top_p: -1 sentinel values
    // that cause "invalid value: integer -1, expected u32" API errors
    // =========================================================================
    if (provider === "anthropic") {
      // Use per-task API key and base URL if available, otherwise fall back to global
      const anthropicApiKey = (taskConfig?.provider === "anthropic" ? taskConfig.apiKey : null)
        || apiKey
        || process.env.ANTHROPIC_API_KEY;
      const anthropicBaseUrl = (taskConfig?.provider === "anthropic" ? taskConfig.baseUrl : null)
        || process.env.ANTHROPIC_BASE_URL;

      const anthropicModel = new ChatAnthropicFiltered({
        model: modelName,
        apiKey: anthropicApiKey,
        maxTokens: thinkingModel ? thinkingMaxTokens : finalMaxTokens,
        temperature: thinkingModel ? undefined : temperature,
        ...(anthropicBaseUrl
          ? { clientOptions: { baseURL: anthropicBaseUrl } }
          : {}),
        ...(thinkingModel && thinkingBudgetTokens
          ? { thinking: { budget_tokens: thinkingBudgetTokens, type: "enabled" as const } }
          : {}),
      });

      logger.info("Using custom ChatAnthropicFiltered with top_k/top_p filtering", {
        modelName,
        hasApiKey: !!anthropicApiKey,
        hasCustomBaseUrl: !!anthropicBaseUrl,
        thinkingModel,
        usingTaskConfig: taskConfig?.provider === "anthropic",
      });

      return anthropicModel as unknown as ConfigurableModel;
    }

    // For other providers (OpenAI), use initChatModel as before
    const modelOptions: InitChatModelArgs = {
      modelProvider: provider,
      max_retries: MAX_RETRIES,
      ...(apiKey ? { apiKey } : {}),
      // Support custom base URL for OpenAI (LiteLLM gateway)
      ...(provider === "openai" && process.env.OPENAI_BASE_URL
        ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
        : {}),
      ...(modelName.includes("gpt-5")
        ? {
          max_completion_tokens: finalMaxTokens,
          temperature: 1,
        }
        : {
          maxTokens: finalMaxTokens,
          temperature: temperature,
        }),
    };

    logger.debug("Initializing model", {
      provider,
      modelName,
      hasCustomBaseUrl: provider === "openai" && !!process.env.OPENAI_BASE_URL,
      baseUrl: provider === "openai" ? process.env.OPENAI_BASE_URL : undefined,
    });

    return await initChatModel(modelName, modelOptions);
  }

  public getModelConfigs(
    config: GraphConfig,
    task: LLMTask,
    selectedModel: ConfigurableModel,
  ) {
    const configs: ModelLoadConfig[] = [];
    const baseConfig = this.getBaseConfigForTask(config, task);

    const defaultConfig = selectedModel._defaultConfig;
    let selectedModelConfig: ModelLoadConfig | null = null;

    if (defaultConfig) {
      const provider = defaultConfig.modelProvider as Provider;
      const modelName = defaultConfig.model;

      if (provider && modelName) {
        const isThinkingModel = baseConfig.thinkingModel;
        selectedModelConfig = {
          provider,
          modelName,
          ...(modelName.includes("gpt-5")
            ? {
              max_completion_tokens:
                defaultConfig.maxTokens ?? baseConfig.maxTokens,
              temperature: 1,
            }
            : {
              maxTokens: defaultConfig.maxTokens ?? baseConfig.maxTokens,
              temperature:
                defaultConfig.temperature ?? baseConfig.temperature,
            }),
          ...(isThinkingModel
            ? {
              thinkingModel: true,
              thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
            }
            : {}),
        };
        configs.push(selectedModelConfig);
      }
    } else {
      // Handle ChatAnthropicFiltered, ChatGoogleGenAI and other models without _defaultConfig
      // Create selectedModelConfig from baseConfig to ensure primary model is used first
      selectedModelConfig = {
        provider: baseConfig.provider,
        modelName: baseConfig.modelName,
        ...(baseConfig.modelName.includes("gpt-5")
          ? {
            max_completion_tokens: baseConfig.maxTokens,
            temperature: 1,
          }
          : {
            maxTokens: baseConfig.maxTokens,
            temperature: baseConfig.temperature,
          }),
        ...(baseConfig.thinkingModel
          ? {
            thinkingModel: true,
            thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
          }
          : {}),
      };
      configs.push(selectedModelConfig);
    }

    // Add fallback models
    for (const provider of this.config.fallbackOrder) {
      const fallbackModel = this.getDefaultModelForProvider(provider, task);
      if (
        fallbackModel &&
        (!selectedModelConfig ||
          fallbackModel.modelName !== selectedModelConfig.modelName)
      ) {
        // Check if fallback model is a thinking model
        const isThinkingModel =
          (provider === "openai" && fallbackModel.modelName.startsWith("o")) ||
          fallbackModel.modelName.includes("extended-thinking");

        const fallbackConfig = {
          ...fallbackModel,
          ...(fallbackModel.modelName.includes("gpt-5")
            ? {
              max_completion_tokens: baseConfig.maxTokens,
              temperature: 1,
            }
            : {
              maxTokens: baseConfig.maxTokens,
              temperature: isThinkingModel
                ? undefined
                : baseConfig.temperature,
            }),
          ...(isThinkingModel
            ? {
              thinkingModel: true,
              thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
            }
            : {}),
        };
        configs.push(fallbackConfig);
      }
    }

    return configs;
  }

  /**
   * Get the model name for a task from GraphConfig
   */
  public getModelNameForTask(config: GraphConfig, task: LLMTask): string {
    const baseConfig = this.getBaseConfigForTask(config, task);
    return baseConfig.modelName;
  }

  /**
   * Get default temperature based on model
   * Gemini 2.5+ requires temperature = 1.0 to avoid loops
   */
  private getDefaultTemperature(modelStr: string): number {
    const [provider, ...modelNameParts] = modelStr.split(":");
    const modelName = modelNameParts.join(":");

    if (provider === "google-genai") {
      const envTemp = process.env.GOOGLE_TEMPERATURE;
      if (envTemp) {
        return parseFloat(envTemp);
      }
      if (modelName.includes("gemini-2") || modelName.includes("gemini-3")) {
        return 1.0;
      }
    }

    return 0;
  }

  /**
   * Get base configuration for a task from GraphConfig
   */
  private getBaseConfigForTask(
    config: GraphConfig,
    task: LLMTask,
  ): ModelLoadConfig {
    // Use dynamic getter to ensure env vars are read at runtime
    const taskDefaults = getTaskConfigDefaults(task);

    const configuredModelName =
      config.configurable?.[`${task}ModelName`] ?? taskDefaults.modelName;
    const temperature =
      config.configurable?.[`${task}Temperature`] ??
      this.getDefaultTemperature(configuredModelName);

    const modelStr = configuredModelName;
    const [modelProvider, ...modelNameParts] = modelStr.split(":");

    let thinkingModel = false;
    if (modelNameParts[0] === "extended-thinking") {
      thinkingModel = true;
      modelNameParts.shift();
    }

    const modelName = modelNameParts.join(":");
    if (modelProvider === "openai" && modelName.startsWith("o")) {
      thinkingModel = true;
    }
    // Detect Anthropic models with -thinking suffix (e.g., claude-opus-4-5-thinking)
    if (modelProvider === "anthropic" && modelName.endsWith("-thinking")) {
      thinkingModel = true;
    }

    const thinkingBudgetTokens = THINKING_BUDGET_TOKENS;

    return {
      modelName,
      provider: modelProvider as Provider,
      ...(modelName.includes("gpt-5")
        ? {
          max_completion_tokens: config.configurable?.maxTokens ?? 10_000,
          temperature: 1,
        }
        : {
          maxTokens: config.configurable?.maxTokens ?? 10_000,
          temperature,
        }),
      thinkingModel,
      thinkingBudgetTokens,
    };
  }

  /**
   * Get default model for a provider and task
   */
  private getDefaultModelForProvider(
    provider: Provider,
    task: LLMTask,
  ): ModelLoadConfig | null {
    // First try to get from environment variables
    const envModelName = this.getModelFromEnv(provider, task);
    if (envModelName) {
      return { provider, modelName: envModelName };
    }

    // Fallback to hardcoded defaults
    const defaultModels: Record<Provider, Record<LLMTask, string>> = {
      anthropic: {
        [LLMTask.PLANNER]: "claude-opus-4-5",
        [LLMTask.PROGRAMMER]: "claude-opus-4-5",
        [LLMTask.REVIEWER]: "claude-opus-4-5",
        [LLMTask.ROUTER]: "claude-haiku-4-5-latest",
        [LLMTask.SUMMARIZER]: "claude-opus-4-5",
      },
      "google-genai": {
        [LLMTask.PLANNER]: "gemini-3-pro-preview",
        [LLMTask.PROGRAMMER]: "gemini-3-pro-preview",
        [LLMTask.REVIEWER]: "gemini-flash-latest",
        [LLMTask.ROUTER]: "gemini-flash-latest",
        [LLMTask.SUMMARIZER]: "gemini-3-pro-preview",
      },
      openai: {
        // Using LiteLLM gateway with Claude models
        [LLMTask.PLANNER]: "claude-4-5-sonnet",
        [LLMTask.PROGRAMMER]: "claude-4-5-sonnet",
        [LLMTask.REVIEWER]: "claude-4-5-sonnet",
        [LLMTask.ROUTER]: "claude-haiku-4.5",
        [LLMTask.SUMMARIZER]: "claude-haiku-4.5",
      },
    };

    const modelName = defaultModels[provider][task];
    if (!modelName) {
      return null;
    }
    return { provider, modelName };
  }

  /**
   * Get model name from environment variables
   * Supports: {PROVIDER}_{TASK}_MODEL format
   * Example: OPENAI_PROGRAMMER_MODEL, ANTHROPIC_PLANNER_MODEL
   */
  private getModelFromEnv(provider: Provider, task: LLMTask): string | null {
    const providerPrefix =
      provider === "google-genai" ? "GOOGLE" : provider.toUpperCase();
    const taskName = task.toUpperCase();
    const envKey = `${providerPrefix}_${taskName}_MODEL`;

    const envValue = process.env[envKey];
    if (envValue) {
      logger.info(`Using model from env ${envKey}: ${envValue}`);
      return envValue;
    }

    return null;
  }

  /**
   * Circuit breaker methods
   */
  public isCircuitClosed(modelKey: string): boolean {
    const state = this.getCircuitState(modelKey);

    if (state.state === CircuitState.CLOSED) {
      return true;
    }

    if (state.state === CircuitState.OPEN && state.openedAt) {
      const timeElapsed = Date.now() - state.openedAt;
      if (timeElapsed >= this.config.circuitBreakerTimeoutMs) {
        state.state = CircuitState.CLOSED;
        state.failureCount = 0;
        delete state.openedAt;

        logger.info(
          `${modelKey}: Circuit breaker automatically recovered: OPEN → CLOSED`,
          {
            timeElapsed: (timeElapsed / 1000).toFixed(1) + "s",
          },
        );
        return true;
      }
    }

    return false;
  }

  private getCircuitState(modelKey: string): CircuitBreakerState {
    if (!this.circuitBreakers.has(modelKey)) {
      this.circuitBreakers.set(modelKey, {
        state: CircuitState.CLOSED,
        failureCount: 0,
        lastFailureTime: 0,
      });
    }
    return this.circuitBreakers.get(modelKey)!;
  }

  public recordSuccess(modelKey: string): void {
    const circuitState = this.getCircuitState(modelKey);

    circuitState.state = CircuitState.CLOSED;
    circuitState.failureCount = 0;
    delete circuitState.openedAt;

    logger.debug(`${modelKey}: Circuit breaker reset after successful request`);
  }

  public recordFailure(modelKey: string): void {
    const circuitState = this.getCircuitState(modelKey);
    const now = Date.now();

    circuitState.lastFailureTime = now;
    circuitState.failureCount++;

    if (
      circuitState.failureCount >= this.config.circuitBreakerFailureThreshold
    ) {
      circuitState.state = CircuitState.OPEN;
      circuitState.openedAt = now;

      logger.warn(
        `${modelKey}: Circuit breaker opened after ${circuitState.failureCount} failures`,
        {
          timeoutMs: this.config.circuitBreakerTimeoutMs,
          willRetryAt: new Date(
            now + this.config.circuitBreakerTimeoutMs,
          ).toISOString(),
        },
      );
    }
  }

  /**
   * Monitoring and observability methods
   */
  public getCircuitBreakerStatus(): Map<string, CircuitBreakerState> {
    return new Map(this.circuitBreakers);
  }

  /**
   * Cleanup on shutdown
   */
  public shutdown(): void {
    this.circuitBreakers.clear();
    logger.info("Shutdown complete");
  }
}

let globalModelManager: ModelManager | null = null;

export function getModelManager(
  config?: Partial<ModelManagerConfig>,
): ModelManager {
  if (!globalModelManager) {
    globalModelManager = new ModelManager(config);
  }
  return globalModelManager;
}

export function resetModelManager(): void {
  if (globalModelManager) {
    globalModelManager.shutdown();
    globalModelManager = null;
  }
}
