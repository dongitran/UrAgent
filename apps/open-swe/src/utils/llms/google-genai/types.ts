/**
 * Custom ChatGoogleGenAI Types
 * Re-exports from @google/genai SDK and defines LangChain integration types
 * 
 * This module provides type definitions for the custom ChatGoogleGenAI implementation
 * that properly handles Gemini 3's thought signatures for function calling.
 */

import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  FunctionResponse,
  GenerateContentConfig,
  GenerateContentResponse,
  GoogleGenAIOptions,
  HttpOptions,
  Part,
  SafetySetting,
  ThinkingConfig,
  Tool,
  ToolConfig,
  UsageMetadata,
} from "@google/genai";
import {
  FunctionCallingConfigMode,
  HarmBlockMethod,
  HarmBlockThreshold,
  HarmCategory,
  ThinkingLevel,
  Type,
} from "@google/genai";
import type { Schema } from "@google/genai";
import {
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";

// Re-export enums (runtime values)
export {
  HarmCategory,
  HarmBlockThreshold,
  HarmBlockMethod,
  FunctionCallingConfigMode,
  ThinkingLevel,
  Type,
};

// Re-export Schema as type only
export type { Schema };

export type {
  GoogleGenAIOptions,
  GenerateContentConfig,
  HttpOptions,
  SafetySetting,
  Content,
  Part,
  Tool,
  FunctionDeclaration,
  FunctionCall,
  FunctionResponse,
  GenerateContentResponse,
  UsageMetadata,
  ThinkingConfig,
};

/**
 * Extended Part type that includes thoughtSignature
 * This is critical for Gemini 3 function calling support
 */
export interface PartWithThoughtSignature extends Part {
  thoughtSignature?: string;
  thought?: boolean;
}

/**
 * Input parameters for the ChatGoogleGenAI class constructor.
 * Extends BaseChatModelParams and includes Google SDK options.
 */
export interface ChatGoogleGenAIInput extends BaseChatModelParams {
  /**
   * Model name to use.
   * @example "gemini-3-flash-preview"
   */
  model?: string;

  /**
   * Google API key
   */
  apiKey?: string;

  /**
   * API version to use
   */
  apiVersion?: string;

  /**
   * HTTP options for the client (timeout, headers, etc.)
   * @default { timeout: 120000 } // 2 minutes
   */
  httpOptions?: HttpOptions;

  /**
   * Google Cloud project ID (for Vertex AI)
   */
  project?: string;

  /**
   * Google Cloud location (for Vertex AI)
   */
  location?: string;

  /**
   * Whether to use Vertex AI
   */
  vertexai?: boolean;

  /**
   * Whether to use streaming for all calls (invoke/generate).
   * Useful for enabling callbacks during non-streaming calls.
   * @default false
   */
  streaming?: boolean;

  /**
   * Whether to stream usage metadata.
   * @default true
   */
  streamUsage?: boolean;

  /**
   * Default safety settings to apply to all requests.
   */
  safetySettings?: SafetySetting[];

  /**
   * Default temperature.
   */
  temperature?: number;

  /**
   * Default max output tokens.
   */
  maxOutputTokens?: number;

  /**
   * Default topP.
   */
  topP?: number;

  /**
   * Default topK.
   */
  topK?: number;

  /**
   * Default stop sequences.
   */
  stopSequences?: string[];

  /**
   * Default thinking configuration (Gemini 3+).
   */
  thinkingConfig?: ThinkingConfig;
}

/**
 * Call options for the .invoke() / .stream() methods.
 * Extends GenerateContentConfig but overrides 'tools' to support LangChain tools.
 */
export interface ChatGoogleGenAICallOptions
  extends BaseChatModelCallOptions,
    Omit<GenerateContentConfig, "tools" | "toolConfig"> {
  /**
   * Tools to bind to the model.
   * Can be standard LangChain tools (BindToolsInput) or Google GenAI Tool definitions.
   */
  tools?: BindToolsInput[] | Tool[] | Tool;

  /**
   * Tool choice configuration.
   * Can be a standard LangChain tool choice string/object or Google specific config.
   */
  tool_choice?:
    | "auto"
    | "none"
    | "any"
    | string
    | ToolConfig["functionCallingConfig"];

  /**
   * Configuration for specific tools (e.g. retrieval config).
   */
  toolConfig?: ToolConfig;
}

export type { ToolConfig };
