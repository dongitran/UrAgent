/**
 * Custom ChatGoogleGenAI for LangChain.js
 * 
 * This implementation properly handles Gemini 3's thought signatures for function calling.
 * 
 * Key features:
 * - Uses @google/genai SDK directly instead of @langchain/google-genai
 * - Captures thoughtSignature from API responses into response_metadata
 * - Reinjects thoughtSignature when sending subsequent requests
 * - Full LangChain compatibility (extends BaseChatModel)
 * 
 * Why this is needed:
 * Gemini 3 models require thought signatures to be passed back during function calling.
 * The official @langchain/google-genai package doesn't fully support this yet.
 * Without proper thought signature handling, you get:
 * "Function call is missing a thought_signature in functionCall parts"
 */

import { GoogleGenAI, type GoogleGenAIOptions, type HttpOptions } from "@google/genai";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

// Retry configuration
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (network errors, rate limits, server errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
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

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // Add up to 1 second of jitter
  return Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY_MS);
}
import {
  type BaseLanguageModelInput,
  type StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import {
  BaseChatModel,
  BindToolsInput,
  LangSmithParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { Runnable, RunnableSequence } from "@langchain/core/runnables";
import { isStructuredTool } from "@langchain/core/tools";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  type InteropZodType,
  isInteropZodSchema,
} from "@langchain/core/utils/types";

import {
  ChatGoogleGenAICallOptions,
  ChatGoogleGenAIInput,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  GenerateContentConfig,
  Schema,
  ThinkingConfig,
  Tool,
  ToolConfig,
} from "./types.js";
import { convertMessagesToGooglePayload } from "./utils/message-inputs.js";
import {
  convertGoogleResponseToChatGeneration,
  convertGoogleStreamChunkToLangChainChunk,
} from "./utils/message-outputs.js";

/**
 * Converts LangChain tool_choice to Google GenAI toolConfig.
 * 
 * Handles:
 * - "auto" / "any" / "none" - standard modes
 * - Specific tool name (e.g. "respond_and_route") - forces model to call that specific tool
 * - Object format - passed through directly
 */
function convertToolChoiceToConfig(
  toolChoice: ChatGoogleGenAICallOptions["tool_choice"],
  existingConfig?: ToolConfig
): ToolConfig | undefined {
  if (!toolChoice) return existingConfig;

  if (typeof toolChoice === "string") {
    const upperChoice = toolChoice.toUpperCase();
    const modeMap: Record<string, FunctionCallingConfigMode> = {
      AUTO: FunctionCallingConfigMode.AUTO,
      ANY: FunctionCallingConfigMode.ANY,
      NONE: FunctionCallingConfigMode.NONE,
    };

    if (modeMap[upperChoice]) {
      // Standard mode: auto, any, none
      return {
        functionCallingConfig: {
          mode: modeMap[upperChoice],
        },
      };
    } else {
      // Specific tool name - force the model to call this specific tool
      // In Google GenAI, this is done with mode: ANY + allowedFunctionNames
      return {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: [toolChoice],
        },
      };
    }
  } else if (typeof toolChoice === "object") {
    return {
      functionCallingConfig: toolChoice,
    };
  }

  return existingConfig;
}

/**
 * Custom Google Gemini Chat Model integration with thought signature support.
 * 
 * This class extends LangChain's BaseChatModel and uses the @google/genai SDK
 * directly to properly handle Gemini 3's thought signatures for function calling.
 */
export class ChatGoogleGenAI extends BaseChatModel<ChatGoogleGenAICallOptions> {
  static override lc_name() {
    return "ChatGoogleGenAI";
  }

  override get lc_secrets(): { [key: string]: string } | undefined {
    return {
      apiKey: "GOOGLE_API_KEY",
    };
  }

  model = "gemini-3-flash-preview";

  apiKey?: string;

  clientOptions?: GoogleGenAIOptions;

  temperature?: number;

  maxOutputTokens?: number;

  topP?: number;

  topK?: number;

  stopSequences?: string[];

  safetySettings?: ChatGoogleGenAIInput["safetySettings"];

  thinkingConfig?: ThinkingConfig;

  httpOptions?: HttpOptions;

  streamUsage = true;

  streaming = false;

  private client: GoogleGenAI;

  // Bound tools storage - set by bindTools()
  private boundTools?: BindToolsInput[];
  private boundToolChoice?: ChatGoogleGenAICallOptions["tool_choice"];

  constructor(fields?: ChatGoogleGenAIInput) {
    super(fields ?? {});

    this.model = fields?.model ?? this.model;
    this.apiKey = fields?.apiKey ?? getEnvironmentVariable("GOOGLE_API_KEY");

    if (!this.apiKey) {
      throw new Error(
        "Google API key not found. Please set the GOOGLE_API_KEY environment variable or pass it to the constructor."
      );
    }

    this.clientOptions = {
      apiKey: this.apiKey,
      apiVersion: fields?.apiVersion,
      httpOptions: fields?.httpOptions ?? {
        // Default timeout: 120 seconds (2 minutes)
        // This prevents hanging requests and allows fallback to work properly
        timeout: 120000,
      },
      project: fields?.project,
      location: fields?.location,
      vertexai: fields?.vertexai,
    };

    // Store httpOptions for reference
    this.httpOptions = this.clientOptions.httpOptions;

    this.temperature = fields?.temperature;
    this.maxOutputTokens = fields?.maxOutputTokens;
    this.topP = fields?.topP;
    this.topK = fields?.topK;
    this.stopSequences = fields?.stopSequences;
    this.safetySettings = fields?.safetySettings;
    this.thinkingConfig = fields?.thinkingConfig;
    this.streaming = fields?.streaming ?? this.streaming;
    this.streamUsage = fields?.streamUsage ?? this.streamUsage;

    this.client = new GoogleGenAI(this.clientOptions);
  }

  _llmType() {
    return "google_genai";
  }

  override getLsParams(options: this["ParsedCallOptions"]): LangSmithParams {
    return {
      ls_provider: "google_genai",
      ls_model_name: this.model,
      ls_model_type: "chat",
      ls_temperature: options.temperature ?? this.temperature,
      ls_max_tokens: options.maxOutputTokens ?? this.maxOutputTokens,
      ls_stop: options.stop,
    };
  }

  /**
   * Get the parameters used to invoke the model
   */
  override invocationParams(
    options?: this["ParsedCallOptions"]
  ): GenerateContentConfig {
    return {
      candidateCount: 1,
      stopSequences: options?.stopSequences ?? this.stopSequences,
      maxOutputTokens: options?.maxOutputTokens ?? this.maxOutputTokens,
      temperature: options?.temperature ?? this.temperature,
      topP: options?.topP ?? this.topP,
      topK: options?.topK ?? this.topK,
      safetySettings: options?.safetySettings ?? this.safetySettings,
      thinkingConfig: options?.thinkingConfig ?? this.thinkingConfig,
      // Merge other generation config params
      responseMimeType: options?.responseMimeType,
      responseSchema: options?.responseSchema,
      mediaResolution: options?.mediaResolution,
      responseModalities: options?.responseModalities,
      speechConfig: options?.speechConfig,
    };
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    // If streaming is enabled in constructor, use the streaming method and aggregate results
    if (this.streaming) {
      const stream = this._streamResponseChunks(messages, options, runManager);
      let finalChunk: ChatGenerationChunk | undefined;
      for await (const chunk of stream) {
        if (finalChunk === undefined) {
          finalChunk = chunk;
        } else {
          finalChunk = finalChunk.concat(chunk);
        }
      }
      if (finalChunk === undefined) {
        throw new Error("No chunks returned from Google GenAI.");
      }
      return {
        generations: [
          {
            text: finalChunk.text,
            message: finalChunk.message,
          },
        ],
      };
    }

    const params = this.invocationParams(options);
    const { contents, systemInstruction } =
      convertMessagesToGooglePayload(messages);
    
    // Use tools from options first, then fall back to bound tools
    const toolsToUse = options.tools ?? this.boundTools;
    const tools = this._formatTools(toolsToUse);

    // Use tool_choice from options first, then fall back to bound tool_choice
    const toolChoiceToUse = options.tool_choice ?? this.boundToolChoice;
    
    // Handle tool_choice - convert to Google GenAI toolConfig format
    const toolConfig = convertToolChoiceToConfig(toolChoiceToUse, options.toolConfig);

    console.error(`[Gemini Debug] ChatGoogleGenAI._generate`, {
      hasOptionsTools: !!options.tools,
      hasBoundTools: !!this.boundTools,
      toolsToUseCount: Array.isArray(toolsToUse) ? toolsToUse.length : 0,
      formattedToolsCount: tools?.length ?? 0,
      toolChoiceToUse,
      toolConfig: JSON.stringify(toolConfig),
    });

    const config: GenerateContentConfig = {
      ...params,
      systemInstruction: systemInstruction?.parts,
      tools,
      toolConfig,
    };

    // Retry logic with exponential backoff
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents,
          config,
        });

        const generation = convertGoogleResponseToChatGeneration(response);
        return {
          generations: [generation],
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
          const delay = calculateRetryDelay(attempt);
          console.error(`[Gemini Retry] _generate attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${delay}ms`, {
            error: lastError.message,
            model: this.model,
          });
          await sleep(delay);
        } else {
          // Non-retryable error or last attempt
          console.error(`[Gemini Retry] _generate failed after ${attempt + 1} attempts`, {
            error: lastError.message,
            model: this.model,
            isRetryable: isRetryableError(error),
          });
          throw lastError;
        }
      }
    }

    throw lastError || new Error("Unknown error in _generate");
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const params = this.invocationParams(options);
    const { contents, systemInstruction } =
      convertMessagesToGooglePayload(messages);
    
    // Use tools from options first, then fall back to bound tools
    const toolsToUse = options.tools ?? this.boundTools;
    const tools = this._formatTools(toolsToUse);

    // Use tool_choice from options first, then fall back to bound tool_choice
    const toolChoiceToUse = options.tool_choice ?? this.boundToolChoice;
    
    // Handle tool_choice - convert to Google GenAI toolConfig format
    const toolConfig = convertToolChoiceToConfig(toolChoiceToUse, options.toolConfig);

    console.error(`[Gemini Debug] ChatGoogleGenAI._streamResponseChunks`, {
      hasOptionsTools: !!options.tools,
      optionsToolsCount: Array.isArray(options.tools) ? options.tools.length : 0,
      hasBoundTools: !!this.boundTools,
      boundToolsCount: this.boundTools?.length ?? 0,
      boundToolNames: this.boundTools?.map((t: any) => t?.name || 'unnamed') ?? [],
      toolsToUseCount: Array.isArray(toolsToUse) ? toolsToUse.length : 0,
      formattedToolsCount: tools?.length ?? 0,
      formattedToolDetails: tools?.map(t => {
        if ('functionDeclarations' in t) {
          return { type: 'functionDeclarations', count: t.functionDeclarations?.length ?? 0, names: t.functionDeclarations?.map(f => f.name) };
        }
        return { type: 'other' };
      }),
      toolChoiceToUse,
      boundToolChoice: this.boundToolChoice,
      toolConfig: JSON.stringify(toolConfig),
    });

    const config: GenerateContentConfig = {
      ...params,
      systemInstruction: systemInstruction?.parts,
      tools,
      toolConfig,
    };

    // Debug: Log thinkingConfig to verify it's being passed
    console.error(`[Gemini Debug] _streamResponseChunks: Config with thinkingConfig`, {
      hasThinkingConfig: !!params.thinkingConfig,
      thinkingConfig: params.thinkingConfig,
      includeThoughts: params.thinkingConfig?.includeThoughts,
    });

    // Retry logic with exponential backoff - ONLY for stream initialization
    // We cannot retry during stream iteration because chunks already yielded cannot be rolled back
    let stream: AsyncIterable<any> | undefined;
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Initialize stream - this is where most network errors occur
        stream = await this.client.models.generateContentStream({
          model: this.model,
          contents,
          config,
        });
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
          const delay = calculateRetryDelay(attempt);
          console.error(`[Gemini Retry] _streamResponseChunks init attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${delay}ms`, {
            error: lastError.message,
            model: this.model,
          });
          await sleep(delay);
        } else {
          console.error(`[Gemini Retry] _streamResponseChunks init failed after ${attempt + 1} attempts`, {
            error: lastError.message,
            model: this.model,
            isRetryable: isRetryableError(error),
          });
          throw lastError;
        }
      }
    }

    if (!stream) {
      throw lastError || new Error("Failed to initialize stream after all retries");
    }

    // Track the LAST thoughtSignature seen during streaming
    // This is critical because LangChain's concat() may concatenate signatures incorrectly
    let lastThoughtSignature: string | undefined;
    let accumulatedChunk: ChatGenerationChunk | undefined;
    
    // Iterate stream - NO retry here because we can't rollback already-yielded chunks
    for await (const chunk of stream) {
      const generationChunk = convertGoogleStreamChunkToLangChainChunk(chunk);
      if (generationChunk) {
        // Capture the thoughtSignature from this chunk BEFORE concatenation
        const chunkSignature = generationChunk.message.response_metadata?.thoughtSignature as string | undefined;
        if (chunkSignature) {
          lastThoughtSignature = chunkSignature;
          console.error(`[Gemini Debug] Captured thoughtSignature from stream chunk`, {
            signaturePreview: chunkSignature.slice(0, 50) + '...',
          });
        }
        
        // Track accumulated chunk to check final response_metadata
        if (accumulatedChunk === undefined) {
          accumulatedChunk = generationChunk;
        } else {
          accumulatedChunk = accumulatedChunk.concat(generationChunk);
          
          // CRITICAL: After concat, the signature may be corrupted (concatenated)
          // Override with the last known good signature
          if (lastThoughtSignature && accumulatedChunk.message.response_metadata) {
            const currentSignature = accumulatedChunk.message.response_metadata.thoughtSignature as string | undefined;
            if (currentSignature && currentSignature !== lastThoughtSignature) {
              console.error(`[Gemini Debug] Fixing corrupted signature after concat`, {
                currentLength: currentSignature.length,
                lastGoodLength: lastThoughtSignature.length,
              });
              accumulatedChunk.message.response_metadata["thoughtSignature"] = lastThoughtSignature;
            }
          }
        }
        
        yield generationChunk;
        await runManager?.handleLLMNewToken(
          generationChunk.text ?? "",
          undefined,
          undefined,
          undefined,
          undefined,
          {
            chunk: generationChunk,
          }
        );
      }
    }

    // Debug: Log final accumulated chunk to see if thoughtSignature is preserved
    if (accumulatedChunk) {
      const finalMetadata = accumulatedChunk.message.response_metadata;
      const aiMessage = accumulatedChunk.message as AIMessageChunk;
      
      // Final validation: ensure the signature is not corrupted
      if (finalMetadata?.thoughtSignature && lastThoughtSignature) {
        const finalSignature = finalMetadata.thoughtSignature as string;
        if (finalSignature !== lastThoughtSignature) {
          console.error(`[Gemini Debug] FINAL FIX: Signature was corrupted, using last good signature`, {
            corruptedLength: finalSignature.length,
            lastGoodLength: lastThoughtSignature.length,
          });
          finalMetadata["thoughtSignature"] = lastThoughtSignature;
        }
      }
      
      console.error(`[Gemini Debug] Stream completed - final accumulated chunk`, {
        hasResponseMetadata: !!finalMetadata,
        hasThoughtSignature: !!finalMetadata?.thoughtSignature,
        thoughtSignaturePreview: finalMetadata?.thoughtSignature 
          ? (finalMetadata.thoughtSignature as string).slice(0, 50) + '...'
          : undefined,
        hasToolCalls: (aiMessage.tool_calls?.length ?? 0) > 0,
        toolCallCount: aiMessage.tool_calls?.length ?? 0,
        toolCallNames: aiMessage.tool_calls?.map(tc => tc.name) ?? [],
      });
    }
  }

  override bindTools(
    tools: ChatGoogleGenAICallOptions["tools"],
    kwargs?: Partial<ChatGoogleGenAICallOptions>
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatGoogleGenAICallOptions> {
    console.error(`[Gemini Debug] ChatGoogleGenAI.bindTools called`, {
      toolCount: Array.isArray(tools) ? tools.length : 'not array',
      toolNames: Array.isArray(tools) ? tools.map((t: any) => t?.name || 'unnamed') : [],
      kwargs,
    });

    // Create a new instance with the same config but with bound tools
    const boundInstance = new ChatGoogleGenAI({
      model: this.model,
      apiKey: this.apiKey,
      httpOptions: this.httpOptions,
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      topP: this.topP,
      topK: this.topK,
      stopSequences: this.stopSequences,
      safetySettings: this.safetySettings,
      thinkingConfig: this.thinkingConfig,
      streaming: this.streaming,
      streamUsage: this.streamUsage,
    });

    // Set bound tools directly on the new instance
    boundInstance.boundTools = tools as BindToolsInput[];
    boundInstance.boundToolChoice = kwargs?.tool_choice;

    // Also set _queuedMethodOperations for FallbackRunnable.extractBoundTools() to find
    (boundInstance as any)._queuedMethodOperations = {
      bindTools: [tools, kwargs || {}],
    };

    console.error(`[Gemini Debug] ChatGoogleGenAI.bindTools result`, {
      boundInstanceType: boundInstance?.constructor?.name,
      hasBoundTools: !!boundInstance.boundTools,
      boundToolsCount: boundInstance.boundTools?.length ?? 0,
      boundToolChoice: boundInstance.boundToolChoice,
      has_queuedMethodOperations: !!(boundInstance as any)._queuedMethodOperations,
    });
    
    return boundInstance;
  }

  /**
   * Override withConfig to preserve bound tools when creating RunnableBinding.
   * This is important because FallbackRunnable calls withConfig() after bindTools().
   */
  override withConfig(
    config: Partial<ChatGoogleGenAICallOptions>
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatGoogleGenAICallOptions> {
    // If this instance has bound tools, create a new instance that preserves them
    if (this.boundTools) {
      const newInstance = new ChatGoogleGenAI({
        model: this.model,
        apiKey: this.apiKey,
        httpOptions: this.httpOptions,
        temperature: config.temperature ?? this.temperature,
        maxOutputTokens: config.maxOutputTokens ?? this.maxOutputTokens,
        topP: config.topP ?? this.topP,
        topK: config.topK ?? this.topK,
        stopSequences: config.stopSequences ?? this.stopSequences,
        safetySettings: config.safetySettings ?? this.safetySettings,
        thinkingConfig: config.thinkingConfig ?? this.thinkingConfig,
        streaming: this.streaming,
        streamUsage: this.streamUsage,
      });

      // Preserve bound tools
      newInstance.boundTools = this.boundTools;
      newInstance.boundToolChoice = this.boundToolChoice;

      // Preserve _queuedMethodOperations
      if ((this as any)._queuedMethodOperations) {
        (newInstance as any)._queuedMethodOperations = (this as any)._queuedMethodOperations;
      }

      console.error(`[Gemini Debug] ChatGoogleGenAI.withConfig preserving bound tools`, {
        hasBoundTools: !!newInstance.boundTools,
        boundToolsCount: newInstance.boundTools?.length ?? 0,
      });

      return newInstance;
    }

    // No bound tools, use default behavior
    return super.withConfig(config);
  }

  override withStructuredOutput<
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    outputSchema: InteropZodType<RunOutput> | Record<string, any>,
    config?: StructuredOutputMethodOptions<false>
  ): Runnable<BaseLanguageModelInput, RunOutput>;

  override withStructuredOutput<
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    outputSchema: InteropZodType<RunOutput> | Record<string, any>,
    config?: StructuredOutputMethodOptions<true>
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;

  override withStructuredOutput<
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    outputSchema: InteropZodType<RunOutput> | Record<string, any>,
    config?: StructuredOutputMethodOptions<boolean>
  ):
    | Runnable<BaseLanguageModelInput, RunOutput>
    | Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }> {
    const schema = outputSchema;
    const method = config?.method;
    const includeRaw = config?.includeRaw;

    if (method === "jsonMode") {
      throw new Error(
        "Google GenAI does not support 'jsonMode'. Use 'jsonSchema' or 'functionCalling'."
      );
    }

    let llm: Runnable<BaseLanguageModelInput>;
    let outputParser: Runnable<BaseMessage, RunOutput>;

    if (method === "jsonSchema" || method === undefined) {
      // Use Google's native JSON schema support
      const jsonSchema = isInteropZodSchema(schema) ? toJsonSchema(schema) : schema;

      llm = this.withConfig({
        responseMimeType: "application/json",
        responseSchema: jsonSchema as Schema,
      } as Partial<ChatGoogleGenAICallOptions>);

      outputParser = new JsonOutputParser<RunOutput>();
    } else {
      throw new Error(
        `Unrecognized structured output method '${method}'. Google GenAI supports 'jsonSchema'.`
      );
    }

    if (includeRaw) {
      return RunnableSequence.from([
        {
          raw: llm,
        },
        {
          raw: (input: { raw: BaseMessage }) => input.raw,
          parsed: (input: { raw: BaseMessage }) => outputParser.invoke(input.raw),
        },
      ]);
    }

    return llm.pipe(outputParser) as Runnable<BaseLanguageModelInput, RunOutput>;
  }

  /**
   * Formats tools for the Google GenAI API.
   */
  private _formatTools(
    tools?: ChatGoogleGenAICallOptions["tools"]
  ): Tool[] | undefined {
    console.error(`[Gemini Debug] _formatTools ENTRY`, {
      toolsProvided: !!tools,
      toolsType: typeof tools,
      toolsIsArray: Array.isArray(tools),
      toolsLength: Array.isArray(tools) ? tools.length : 'N/A',
    });

    if (!tools) {
      console.error(`[Gemini Debug] _formatTools: tools is falsy, returning undefined`);
      return undefined;
    }

    const toolList = Array.isArray(tools) ? tools : [tools];
    console.error(`[Gemini Debug] _formatTools: toolList created`, {
      toolListLength: toolList.length,
    });

    if (toolList.length === 0) {
      console.error(`[Gemini Debug] _formatTools: toolList is empty, returning undefined`);
      return undefined;
    }

    const functionDeclarations: FunctionDeclaration[] = [];
    const googleTools: Tool[] = [];

    console.error(`[Gemini Debug] _formatTools processing`, {
      toolCount: toolList.length,
      toolTypes: toolList.map((t, idx) => {
        const keys = t ? Object.keys(t) : [];
        const schemaObj = (t as any)?.schema;
        return {
          index: idx,
          keys,
          hasName: t && 'name' in t,
          hasDescription: t && 'description' in t,
          hasSchema: t && 'schema' in t,
          hasFunctionDeclarations: t && 'functionDeclarations' in t,
          isStructuredTool: isStructuredTool(t as any),
          constructorName: (t as any)?.constructor?.name,
          name: (t as any)?.name,
          // Deep schema inspection
          schemaExists: !!schemaObj,
          schemaType: typeof schemaObj,
          schemaConstructorName: schemaObj?.constructor?.name,
          schemaHas_def: schemaObj && '_def' in schemaObj,
          schemaHas_zod: schemaObj && '_zod' in schemaObj,
          schema_defTypeName: schemaObj?._def?.typeName,
        };
      }),
    });

    for (let i = 0; i < toolList.length; i++) {
      const tool = toolList[i];
      console.error(`[Gemini Debug] _formatTools: Processing tool ${i}`, {
        toolExists: !!tool,
        toolType: typeof tool,
      });

      if (!tool) {
        console.error(`[Gemini Debug] _formatTools: Tool ${i} is null/undefined, skipping`);
        continue;
      }

      // Handle Google Native Tool
      if (
        "functionDeclarations" in tool ||
        "googleSearch" in tool ||
        "codeExecution" in tool
      ) {
        googleTools.push(tool as Tool);
        console.error(`[Gemini Debug] _formatTools: Added Google Native Tool at index ${i}`);
        continue;
      }

      // Handle LangChain Tool (BindToolsInput) - can be StructuredTool or plain object with schema
      const lcTool = tool as BindToolsInput;
      
      const isStructured = isStructuredTool(lcTool);
      const hasNameProp = 'name' in lcTool;
      const hasSchemaProp = 'schema' in lcTool;
      
      console.error(`[Gemini Debug] _formatTools: Tool ${i} type check`, {
        isStructuredTool: isStructured,
        hasNameProp,
        hasSchemaProp,
        willUseStructuredToolBranch: isStructured,
        willUsePlainToolBranch: !isStructured && hasNameProp && hasSchemaProp,
      });
      
      // Check if it's a StructuredTool (has _call method) or a plain tool definition object
      if (isStructured) {
        // StructuredTool - use its schema directly
        const schemaIsZod = isInteropZodSchema(lcTool.schema);
        console.error(`[Gemini Debug] _formatTools: StructuredTool schema check`, {
          name: lcTool.name,
          schemaIsZod,
        });
        
        const schema = schemaIsZod
          ? toJsonSchema(lcTool.schema)
          : lcTool.schema;
        functionDeclarations.push({
          name: lcTool.name,
          description: lcTool.description,
          parameters: schema as Schema,
        });
        console.error(`[Gemini Debug] _formatTools: Added StructuredTool`, { name: lcTool.name });
      } else if (hasNameProp && hasSchemaProp) {
        // Plain tool definition object with { name, description, schema }
        // This is the format used by LangChain's bindTools when passing tool definitions
        const toolDef = lcTool as { name: string; description?: string; schema: any };
        
        const schemaIsZod = isInteropZodSchema(toolDef.schema);
        console.error(`[Gemini Debug] _formatTools processing plain tool definition`, {
          name: toolDef.name,
          hasDescription: !!toolDef.description,
          schemaType: typeof toolDef.schema,
          schemaConstructor: toolDef.schema?.constructor?.name,
          isZodSchema: schemaIsZod,
          schemaHas_def: toolDef.schema && '_def' in toolDef.schema,
          schemaHas_zod: toolDef.schema && '_zod' in toolDef.schema,
          schema_defTypeName: toolDef.schema?._def?.typeName,
          schemaKeys: toolDef.schema ? Object.keys(toolDef.schema).slice(0, 15) : [],
        });

        let schema: any;
        try {
          if (schemaIsZod) {
            console.error(`[Gemini Debug] _formatTools: Converting Zod schema to JSON schema`);
            schema = toJsonSchema(toolDef.schema);
          } else {
            console.error(`[Gemini Debug] _formatTools: Using schema as-is (not Zod)`);
            schema = toolDef.schema;
          }
          
          console.error(`[Gemini Debug] _formatTools schema converted`, {
            name: toolDef.name,
            convertedSchemaType: typeof schema,
            convertedSchemaKeys: schema ? Object.keys(schema).slice(0, 15) : [],
            convertedSchema: JSON.stringify(schema).slice(0, 500),
          });
        } catch (err) {
          console.error(`[Gemini Debug] _formatTools schema conversion error`, {
            name: toolDef.name,
            error: err instanceof Error ? err.message : String(err),
            errorStack: err instanceof Error ? err.stack : undefined,
          });
          schema = toolDef.schema;
        }

        functionDeclarations.push({
          name: toolDef.name,
          description: toolDef.description || '',
          parameters: schema as Schema,
        });
        console.error(`[Gemini Debug] _formatTools: Added plain tool definition`, { 
          name: toolDef.name,
          functionDeclarationsCountNow: functionDeclarations.length,
        });
      } else {
        console.error(`[Gemini Debug] _formatTools: Tool ${i} not recognized - SKIPPING`, {
          toolKeys: Object.keys(tool),
          hasName: 'name' in tool,
          hasSchema: 'schema' in tool,
          toolStringified: JSON.stringify(tool).slice(0, 300),
        });
      }
    }

    console.error(`[Gemini Debug] _formatTools FINAL result`, {
      functionDeclarationsCount: functionDeclarations.length,
      functionNames: functionDeclarations.map(f => f.name),
      googleToolsCount: googleTools.length,
      willAddFunctionDeclarations: functionDeclarations.length > 0,
    });

    if (functionDeclarations.length > 0) {
      googleTools.push({ functionDeclarations });
    }

    const result = googleTools.length > 0 ? googleTools : undefined;
    console.error(`[Gemini Debug] _formatTools RETURNING`, {
      resultExists: !!result,
      resultLength: result?.length ?? 0,
    });

    return result;
  }
}
