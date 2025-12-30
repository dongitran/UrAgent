/**
 * Custom ChatGoogleGenAI Module
 * 
 * This module provides a custom implementation of ChatGoogleGenAI that properly
 * handles Gemini 3's thought signatures for function calling.
 * 
 * Usage:
 * ```typescript
 * import { ChatGoogleGenAI } from "./google-genai/index.js";
 * 
 * const model = new ChatGoogleGenAI({
 *   model: "gemini-3-flash-preview",
 *   apiKey: process.env.GOOGLE_API_KEY,
 *   temperature: 1.0,
 * });
 * 
 * const result = await model.invoke(messages);
 * ```
 * 
 * Why this exists:
 * - Gemini 3 models require thought signatures to be passed back during function calling
 * - The official @langchain/google-genai package doesn't fully support this yet
 * - This implementation uses @google/genai SDK directly with proper thought signature handling
 */

export { ChatGoogleGenAI } from "./chat-model.js";
export * from "./types.js";
export * from "./utils/index.js";
