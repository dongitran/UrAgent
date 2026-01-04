import { GraphConfig } from "@openswe/shared/open-swe/types";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import { ModelManager, Provider } from "./llms/model-manager.js";
import { createLogger, LogLevel } from "./logger.js";
import { Runnable, RunnableConfig } from "@langchain/core/runnables";
import { StructuredToolInterface } from "@langchain/core/tools";
import {
  ConfigurableChatModelCallOptions,
  ConfigurableModel,
} from "langchain/chat_models/universal";
import {
  AIMessageChunk,
  BaseMessage,
  BaseMessageLike,
} from "@langchain/core/messages";
import { ChatResult, ChatGeneration } from "@langchain/core/outputs";
import { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { getMessageContentString } from "@openswe/shared/messages";
import { getConfig } from "@langchain/langgraph";
import { MODELS_NO_PARALLEL_TOOL_CALLING } from "./llms/load-model.js";

const logger = createLogger(LogLevel.DEBUG, "FallbackRunnable");

// Debug logging controlled by GEMINI_DEBUG env var
const GEMINI_DEBUG = process.env.GEMINI_DEBUG === 'true';

function debugLog(message: string, data?: Record<string, unknown>): void {
  if (GEMINI_DEBUG) {
    logger.debug(message, data);
  }
}

// Retry configuration for FallbackRunnable
const FALLBACK_MAX_RETRIES = 5;
const FALLBACK_INITIAL_DELAY_MS = 1000; // 1 second
const FALLBACK_MAX_DELAY_MS = 30000; // 30 seconds

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = FALLBACK_INITIAL_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // Add up to 1 second of jitter
  return Math.min(exponentialDelay + jitter, FALLBACK_MAX_DELAY_MS);
}

/**
 * Check if an error is retryable (network errors, rate limits, server errors, abort errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();
    
    // Abort errors (timeout, cancelled requests)
    if (errorName === 'aborterror' || 
        message.includes('abort') || 
        message.includes('aborted') ||
        message.includes('operation was aborted')) {
      return true;
    }
    // Network errors
    if (message.includes('fetch failed') || 
        message.includes('network') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('etimedout') ||
        message.includes('socket hang up')) {
      return true;
    }
    // Rate limit errors (429)
    if (message.includes('429') || message.includes('rate limit') || message.includes('quota')) {
      return true;
    }
    // Server errors (5xx)
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
      return true;
    }
  }
  return false;
}

interface ExtractedTools {
  tools: BindToolsInput[];
  kwargs: Record<string, any>;
}

function useProviderMessages(
  initialInput: BaseLanguageModelInput,
  providerMessages?: Record<Provider, BaseMessageLike[]>,
  provider?: Provider,
): BaseLanguageModelInput {
  if (!provider || !providerMessages?.[provider]) {
    return initialInput;
  }
  return providerMessages[provider];
}

export class FallbackRunnable<
  RunInput extends BaseLanguageModelInput = BaseLanguageModelInput,
  CallOptions extends ConfigurableChatModelCallOptions =
    ConfigurableChatModelCallOptions,
> extends ConfigurableModel<RunInput, CallOptions> {
  private primaryRunnable: any;
  private config: GraphConfig;
  private task: LLMTask;
  private modelManager: ModelManager;
  private providerTools?: Record<Provider, BindToolsInput[]>;
  private providerMessages?: Record<Provider, BaseMessageLike[]>;

  constructor(
    primaryRunnable: any,
    config: GraphConfig,
    task: LLMTask,
    modelManager: ModelManager,
    options?: {
      providerTools?: Record<Provider, BindToolsInput[]>;
      providerMessages?: Record<Provider, BaseMessageLike[]>;
    },
  ) {
    super({
      configurableFields: "any",
      configPrefix: "fallback",
      queuedMethodOperations: {},
      disableStreaming: false,
    });
    this.primaryRunnable = primaryRunnable;
    this.config = config;
    this.task = task;
    this.modelManager = modelManager;
    this.providerTools = options?.providerTools;
    this.providerMessages = options?.providerMessages;
  }

  async _generate(
    messages: BaseMessage[],
    options?: Record<string, any>,
  ): Promise<ChatResult> {
    const result = await this.invoke(messages, options);
    const generation: ChatGeneration = {
      message: result,
      text: result?.content ? getMessageContentString(result.content) : "",
    };
    return {
      generations: [generation],
      llmOutput: {},
    };
  }

  async invoke(
    input: BaseLanguageModelInput,
    options?: Record<string, any>,
  ): Promise<AIMessageChunk> {
    const modelConfigs = this.modelManager.getModelConfigs(
      this.config,
      this.task,
      this.getPrimaryModel(),
    );

    debugLog(`[Gemini Debug] FallbackRunnable.invoke starting`, {
      task: this.task,
      totalConfigs: modelConfigs.length,
      configProviders: modelConfigs.map((c) => c.provider),
      hasProviderMessages: !!this.providerMessages,
      providerMessageKeys: this.providerMessages
        ? Object.keys(this.providerMessages)
        : [],
    });

    let lastError: Error | undefined;

    for (let i = 0; i < modelConfigs.length; i++) {
      const modelConfig = modelConfigs[i];
      const modelKey = `${modelConfig.provider}:${modelConfig.modelName}`;

      debugLog(
        `[Gemini Debug] Trying model ${i + 1}/${modelConfigs.length}`,
        {
          modelKey,
          provider: modelConfig.provider,
          modelName: modelConfig.modelName,
        },
      );

      if (!this.modelManager.isCircuitClosed(modelKey)) {
        logger.warn(`Circuit breaker open for ${modelKey}, skipping`);
        continue;
      }

      const graphConfig = getConfig() as GraphConfig;

      try {
        debugLog(`[Gemini Debug] About to initializeModel for fallback`, {
          provider: modelConfig.provider,
          modelName: modelConfig.modelName,
        });

        const model = await this.modelManager.initializeModel(
          modelConfig,
          graphConfig,
        );

        debugLog(`[Gemini Debug] Model initialized for fallback`, {
          provider: modelConfig.provider,
          modelType: model?.constructor?.name,
          modelLlmType: (model as any)?._llmType?.(),
          hasBindTools: typeof (model as any)?.bindTools === 'function',
        });

        let runnableToUse: Runnable<BaseLanguageModelInput, AIMessageChunk> =
          model;

        // Check if provider-specific tools exist for this provider
        const providerSpecificTools =
          this.providerTools?.[modelConfig.provider];
        let toolsToUse: ExtractedTools | null = null;

        if (providerSpecificTools) {
          // Use provider-specific tools if available
          const extractedTools = this.extractBoundTools();
          toolsToUse = {
            tools: providerSpecificTools,
            kwargs: extractedTools?.kwargs || {},
          };
          debugLog(`[Gemini Debug] Using provider-specific tools`, {
            provider: modelConfig.provider,
            toolCount: providerSpecificTools.length,
          });
        } else {
          // Fall back to extracted bound tools from primary model
          toolsToUse = this.extractBoundTools();
          debugLog(`[Gemini Debug] Using extracted bound tools`, {
            provider: modelConfig.provider,
            hasTools: !!toolsToUse,
            toolCount: toolsToUse?.tools?.length || 0,
          });
        }

        if (
          toolsToUse &&
          "bindTools" in runnableToUse &&
          runnableToUse.bindTools
        ) {
          const supportsParallelToolCall =
            !MODELS_NO_PARALLEL_TOOL_CALLING.some(
              (modelName) => modelKey === modelName,
            );

          const kwargs = { ...toolsToUse.kwargs };
          if (!supportsParallelToolCall && "parallel_tool_calls" in kwargs) {
            delete kwargs.parallel_tool_calls;
          }

          // Deep inspection of tools before bindTools
          debugLog(`[Gemini Debug] DEEP TOOL INSPECTION before bindTools`, {
            toolsCount: toolsToUse.tools?.length,
            toolsDetails: toolsToUse.tools?.map((t: any, idx: number) => ({
              index: idx,
              name: t?.name,
              hasDescription: !!t?.description,
              hasSchema: !!t?.schema,
              schemaType: typeof t?.schema,
              schemaConstructorName: t?.schema?.constructor?.name,
              schemaHas_def: t?.schema && '_def' in t.schema,
              schemaHas_zod: t?.schema && '_zod' in t.schema,
              schema_defTypeName: t?.schema?._def?.typeName,
              toolKeys: t ? Object.keys(t) : [],
            })),
            kwargs,
          });

          debugLog(`[Gemini Debug] Before bindTools on new model`, {
            runnableToUseType: runnableToUse?.constructor?.name,
            hasBoundTools: !!(runnableToUse as any)?.boundTools,
            toolsCount: toolsToUse.tools?.length,
            kwargs,
          });

          runnableToUse = (runnableToUse as ConfigurableModel).bindTools(
            toolsToUse.tools,
            kwargs,
          );

          debugLog(`[Gemini Debug] After bindTools on new model`, {
            runnableToUseType: runnableToUse?.constructor?.name,
            hasBoundTools: !!(runnableToUse as any)?.boundTools,
            boundToolsCount: (runnableToUse as any)?.boundTools?.length ?? 0,
            boundToolChoice: (runnableToUse as any)?.boundToolChoice,
          });
        }

        // IMPORTANT: Skip withConfig if model already has boundTools
        // withConfig() can create a RunnableBinding that loses the boundTools
        const config = this.extractConfig();
        const modelHasBoundTools = !!(runnableToUse as any)?.boundTools;
        
        debugLog(`[Gemini Debug] Before withConfig decision`, {
          hasConfig: !!config,
          configKeys: config ? Object.keys(config) : [],
          modelHasBoundTools,
          runnableToUseType: runnableToUse?.constructor?.name,
        });

        // Only apply withConfig if model doesn't have boundTools
        // OR if config doesn't contain tools (to avoid overwriting)
        if (config && !modelHasBoundTools) {
          runnableToUse = runnableToUse.withConfig(config);
          
          debugLog(`[Gemini Debug] After withConfig`, {
            runnableToUseType: runnableToUse?.constructor?.name,
            hasBoundTools: !!(runnableToUse as any)?.boundTools,
          });
        } else if (config && modelHasBoundTools) {
          debugLog(`[Gemini Debug] Skipping withConfig to preserve boundTools`);
        }

        const messagesToInvoke = useProviderMessages(
          input,
          this.providerMessages,
          modelConfig.provider,
        );

        debugLog(`[Gemini Debug] About to invoke model`, {
          provider: modelConfig.provider,
          modelKey,
          inputType: Array.isArray(input) ? "array" : typeof input,
          inputLength: Array.isArray(input) ? input.length : "N/A",
          messagesToInvokeType: Array.isArray(messagesToInvoke)
            ? "array"
            : typeof messagesToInvoke,
          messagesToInvokeLength: Array.isArray(messagesToInvoke)
            ? messagesToInvoke.length
            : "N/A",
          usedProviderMessages: messagesToInvoke !== input,
          hasProviderMessagesForProvider:
            !!this.providerMessages?.[modelConfig.provider],
          providerMessagesLength:
            this.providerMessages?.[modelConfig.provider]?.length || 0,
        });

        // Retry logic with exponential backoff for each model
        let modelLastError: Error | undefined;
        for (let retryAttempt = 0; retryAttempt < FALLBACK_MAX_RETRIES; retryAttempt++) {
          try {
            const result = await runnableToUse.invoke(messagesToInvoke, options);

            debugLog(`[Gemini Debug] Model invocation successful`, {
              provider: modelConfig.provider,
              modelKey,
              retryAttempt,
            });

            this.modelManager.recordSuccess(modelKey);
            return result;
          } catch (invokeError) {
            modelLastError = invokeError instanceof Error ? invokeError : new Error(String(invokeError));
            
            // Check if error is retryable and we have retries left
            if (isRetryableError(invokeError) && retryAttempt < FALLBACK_MAX_RETRIES - 1) {
              const delay = calculateRetryDelay(retryAttempt);
              logger.warn(`[Retry] Model invoke attempt ${retryAttempt + 1}/${FALLBACK_MAX_RETRIES} failed, retrying in ${delay}ms`, {
                provider: modelConfig.provider,
                modelKey,
                error: modelLastError.message,
              });
              await sleep(delay);
            } else {
              // Non-retryable error or last retry attempt - break to try next model
              logger.warn(`[Retry] Model invoke failed after ${retryAttempt + 1} attempts`, {
                provider: modelConfig.provider,
                modelKey,
                error: modelLastError.message,
                isRetryable: isRetryableError(invokeError),
              });
              throw modelLastError;
            }
          }
        }

        // Should not reach here, but just in case
        throw modelLastError || new Error("Unknown error in model invoke");
      } catch (error) {
        debugLog(`[Gemini Debug] ${modelKey} failed`, {
          provider: modelConfig.provider,
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        });
        lastError = error instanceof Error ? error : new Error(String(error));
        this.modelManager.recordFailure(modelKey);
      }
    }

    throw new Error(
      `All fallback models exhausted for task ${this.task}. Last error: ${lastError?.message}`,
    );
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Record<string, any>,
  ): ConfigurableModel<RunInput, CallOptions> {
    debugLog(`[Gemini Debug] FallbackRunnable.bindTools called`, {
      toolCount: tools?.length,
      toolNames: tools?.map((t: any) => t?.name || 'unnamed'),
      kwargs,
      primaryRunnableType: this.primaryRunnable?.constructor?.name,
      primaryHasBindTools: typeof this.primaryRunnable?.bindTools === 'function',
    });

    const boundPrimary =
      this.primaryRunnable.bindTools?.(tools, kwargs) ?? this.primaryRunnable;

    // Deep inspection of boundPrimary after bindTools
    const inspectBoundPrimary = {
      type: boundPrimary?.constructor?.name,
      has_queuedMethodOperations: !!boundPrimary?._queuedMethodOperations,
      queuedMethodOperations_keys: boundPrimary?._queuedMethodOperations ? Object.keys(boundPrimary._queuedMethodOperations) : [],
      hasBindToolsInQueued: !!boundPrimary?._queuedMethodOperations?.bindTools,
      bindToolsIsArray: Array.isArray(boundPrimary?._queuedMethodOperations?.bindTools),
      hasBound: !!boundPrimary?.bound,
      boundType: boundPrimary?.bound?.constructor?.name,
      hasConfig: !!boundPrimary?.config,
      configKeys: boundPrimary?.config ? Object.keys(boundPrimary.config) : [],
      configToolsExists: !!boundPrimary?.config?.tools,
      configToolsLength: Array.isArray(boundPrimary?.config?.tools) ? boundPrimary.config.tools.length : 0,
    };

    debugLog(`[Gemini Debug] FallbackRunnable.bindTools - boundPrimary inspection`, inspectBoundPrimary);

    const newFallback = new FallbackRunnable(
      boundPrimary,
      this.config,
      this.task,
      this.modelManager,
      {
        providerTools: this.providerTools,
        providerMessages: this.providerMessages,
      },
    );

    debugLog(`[Gemini Debug] FallbackRunnable.bindTools - created new FallbackRunnable`, {
      newFallbackPrimaryRunnableType: (newFallback as any).primaryRunnable?.constructor?.name,
      newFallbackPrimaryHasQueuedOps: !!(newFallback as any).primaryRunnable?._queuedMethodOperations,
      newFallbackPrimaryHasConfig: !!(newFallback as any).primaryRunnable?.config,
      newFallbackPrimaryConfigTools: !!(newFallback as any).primaryRunnable?.config?.tools,
    });

    return newFallback as unknown as ConfigurableModel<RunInput, CallOptions>;
  }

  // @ts-expect-error - types are hard man :/
  withConfig(
    config?: RunnableConfig,
  ): ConfigurableModel<RunInput, CallOptions> {
    const configuredPrimary =
      this.primaryRunnable.withConfig?.(config) ?? this.primaryRunnable;
    return new FallbackRunnable(
      configuredPrimary,
      this.config,
      this.task,
      this.modelManager,
      {
        providerTools: this.providerTools,
        providerMessages: this.providerMessages,
      },
    ) as unknown as ConfigurableModel<RunInput, CallOptions>;
  }

  private getPrimaryModel(): ConfigurableModel {
    let current = this.primaryRunnable;

    // Unwrap any LangChain bindings to get to the actual model
    while (current?.bound) {
      current = current.bound;
    }

    // The unwrapped object should be a chat model with _llmType
    if (current && typeof current._llmType !== "undefined") {
      return current;
    }

    throw new Error(
      "Could not extract primary model from runnable - no _llmType found",
    );
  }

  private extractBoundTools(): ExtractedTools | null {
    let current: any = this.primaryRunnable;
    let depth = 0;

    // Deep inspection of primaryRunnable structure
    const inspectObject = (obj: any, label: string) => {
      if (!obj) return { label, exists: false };
      return {
        label,
        exists: true,
        constructorName: obj?.constructor?.name,
        keys: Object.keys(obj).filter(k => !k.startsWith('_') || k === '_queuedMethodOperations'),
        has_queuedMethodOperations: !!obj?._queuedMethodOperations,
        queuedMethodOperations_keys: obj?._queuedMethodOperations ? Object.keys(obj._queuedMethodOperations) : [],
        hasBindTools: !!obj?._queuedMethodOperations?.bindTools,
        bindToolsIsArray: Array.isArray(obj?._queuedMethodOperations?.bindTools),
        bindToolsLength: Array.isArray(obj?._queuedMethodOperations?.bindTools) ? obj._queuedMethodOperations.bindTools.length : 0,
        hasBound: !!obj?.bound,
        hasConfig: !!obj?.config,
        configKeys: obj?.config ? Object.keys(obj.config) : [],
        configToolsExists: !!obj?.config?.tools,
        configToolsIsArray: Array.isArray(obj?.config?.tools),
        configToolsLength: Array.isArray(obj?.config?.tools) ? obj.config.tools.length : 0,
        hasKwargs: !!obj?.kwargs,
        kwargsKeys: obj?.kwargs ? Object.keys(obj.kwargs) : [],
      };
    };

    debugLog(`[Gemini Debug] extractBoundTools starting - DEEP INSPECTION`, {
      primaryRunnable: inspectObject(this.primaryRunnable, 'primaryRunnable'),
      primaryRunnable_bound: inspectObject(this.primaryRunnable?.bound, 'primaryRunnable.bound'),
      primaryRunnable_bound_bound: inspectObject(this.primaryRunnable?.bound?.bound, 'primaryRunnable.bound.bound'),
    });

    // Check _queuedMethodOperations.bindTools first (set by ChatGoogleGenAI.bindTools)
    if (this.primaryRunnable?._queuedMethodOperations?.bindTools) {
      const bindToolsOp = this.primaryRunnable._queuedMethodOperations.bindTools;
      if (Array.isArray(bindToolsOp) && bindToolsOp.length > 0) {
        const tools = bindToolsOp[0] as StructuredToolInterface[];
        const toolOptions = bindToolsOp[1] || {};
        debugLog(`[Gemini Debug] Found tools in primaryRunnable._queuedMethodOperations.bindTools`, {
          toolCount: Array.isArray(tools) ? tools.length : 'not array',
          toolNames: Array.isArray(tools) ? tools.map((t: any) => t?.name || 'unnamed') : [],
          toolOptions,
        });
        return {
          tools: tools,
          kwargs: {
            tool_choice: (toolOptions as Record<string, any>).tool_choice,
            parallel_tool_calls: (toolOptions as Record<string, any>).parallel_tool_calls,
          },
        };
      }
    }

    // Check if tools are directly in config (RunnableBinding from withConfig stores it there)
    if (this.primaryRunnable?.config?.tools) {
      const config = this.primaryRunnable.config;
      debugLog(`[Gemini Debug] Found tools in primaryRunnable.config`, {
        toolCount: Array.isArray(config.tools) ? config.tools.length : 'not array',
        toolNames: Array.isArray(config.tools) ? config.tools.map((t: any) => t?.name || 'unnamed') : [],
        tool_choice: config.tool_choice,
      });
      return {
        tools: config.tools,
        kwargs: {
          tool_choice: config.tool_choice,
          parallel_tool_calls: config.parallel_tool_calls,
        },
      };
    }

    while (current) {
      debugLog(`[Gemini Debug] extractBoundTools traversing`, {
        depth,
        currentType: current?.constructor?.name,
        has_queuedMethodOperations: !!current?._queuedMethodOperations,
        hasBindTools: !!current?._queuedMethodOperations?.bindTools,
        hasBound: !!current?.bound,
        hasConfig: !!current?.config,
        configKeys: current?.config ? Object.keys(current.config) : [],
        configTools: !!current?.config?.tools,
      });

      // Check config.tools (RunnableBinding pattern from withConfig)
      if (current?.config?.tools) {
        const config = current.config;
        debugLog(`[Gemini Debug] Found tools in config at depth ${depth}`, {
          toolCount: Array.isArray(config.tools) ? config.tools.length : 'not array',
          toolNames: Array.isArray(config.tools) ? config.tools.map((t: any) => t?.name || 'unnamed') : [],
          tool_choice: config.tool_choice,
        });
        return {
          tools: config.tools,
          kwargs: {
            tool_choice: config.tool_choice,
            parallel_tool_calls: config.parallel_tool_calls,
          },
        };
      }

      // Check _queuedMethodOperations.bindTools (ConfigurableModel pattern)
      if (current._queuedMethodOperations?.bindTools) {
        const bindToolsOp = current._queuedMethodOperations.bindTools;

        if (Array.isArray(bindToolsOp) && bindToolsOp.length > 0) {
          const tools = bindToolsOp[0] as StructuredToolInterface[];
          const toolOptions = bindToolsOp[1] || {};

          debugLog(`[Gemini Debug] Found tools in _queuedMethodOperations at depth ${depth}`, {
            toolCount: Array.isArray(tools) ? tools.length : 'not array',
            toolNames: Array.isArray(tools) ? tools.map((t: any) => t?.name || 'unnamed') : [],
            toolOptions,
          });

          return {
            tools: tools,
            kwargs: {
              tool_choice: (toolOptions as Record<string, any>).tool_choice,
              parallel_tool_calls: (toolOptions as Record<string, any>)
                .parallel_tool_calls,
            },
          };
        }
      }
      
      depth++;
      current = current.bound;
    }

    debugLog(`[Gemini Debug] extractBoundTools found nothing after ${depth} iterations`);
    return null;
  }

  private extractConfig(): Partial<RunnableConfig> | null {
    let current: any = this.primaryRunnable;

    while (current) {
      if (current.config) {
        return current.config;
      }
      current = current.bound;
    }

    return null;
  }
}
