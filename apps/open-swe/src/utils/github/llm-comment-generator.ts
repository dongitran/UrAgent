import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createLogger, LogLevel } from "../logger.js";

const logger = createLogger(LogLevel.INFO, "LLMCommentGenerator");

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000; // 2 seconds

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the summarizer model configuration from environment
 */
export function getSummarizerModelConfig(): { provider: string; modelName: string } {
  const provider = process.env.LLM_PROVIDER || "openai";
  const providerPrefix = provider === "google-genai" ? "GOOGLE" : provider.toUpperCase();
  const taskEnvKey = `${providerPrefix}_SUMMARIZER_MODEL`;
  const taskEnvValue = process.env[taskEnvKey];
  
  if (taskEnvValue) {
    return { provider, modelName: taskEnvValue };
  }
  
  // Fallback defaults based on provider
  const defaultModels: Record<string, string> = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-20241022",
    "google-genai": "gemini-2.0-flash",
  };
  
  return { 
    provider, 
    modelName: defaultModels[provider] || "gpt-4o-mini" 
  };
}

/**
 * Get API key for provider
 */
export function getApiKeyForProvider(provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google-genai":
      return process.env.GOOGLE_API_KEY;
    default:
      return undefined;
  }
}

/**
 * Call Google Generative AI directly (bypass LangChain wrapper)
 */
async function callGoogleGenAI(modelName: string, apiKey: string, prompt: string): Promise<string> {
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });
  
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return text.trim();
}

/**
 * Generate a comment using LLM with retry logic
 * Works with all providers: OpenAI, Anthropic, Google GenAI
 * For Google GenAI, uses the native SDK directly to avoid LangChain wrapper issues
 * 
 * @param prompt The prompt to send to the LLM
 * @param fallbackMessage Fallback message if LLM fails
 * @param context Optional context for logging (e.g., issueTitle, commentType)
 * @returns Generated comment text or fallback message
 */
export async function generateCommentWithLLM(
  prompt: string,
  fallbackMessage: string,
  context?: Record<string, any>,
): Promise<string> {
  const { provider, modelName } = getSummarizerModelConfig();
  const apiKey = getApiKeyForProvider(provider);
  
  if (!apiKey) {
    logger.warn(`API key not set for provider ${provider}, using fallback message`, context);
    return fallbackMessage;
  }

  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let generatedText: string;

      if (provider === "google-genai") {
        // Use Google Generative AI SDK directly to avoid LangChain wrapper issues
        generatedText = await callGoogleGenAI(modelName, apiKey, prompt);
      } else if (provider === "openai") {
        const model = new ChatOpenAI({
          modelName,
          apiKey,
          temperature: 0.8,
          maxTokens: 5000,
          ...(process.env.OPENAI_BASE_URL ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } } : {}),
        });
        const response = await model.invoke([new HumanMessage(prompt)]);
        generatedText = typeof response.content === 'string'
          ? response.content.trim()
          : Array.isArray(response.content)
            ? response.content.map(c => typeof c === 'string' ? c : '').join('').trim()
            : '';
      } else if (provider === "anthropic") {
        const model = new ChatAnthropic({
          modelName,
          apiKey,
          temperature: 0.8,
          maxTokens: 5000,
        });
        const response = await model.invoke([new HumanMessage(prompt)]);
        generatedText = typeof response.content === 'string'
          ? response.content.trim()
          : Array.isArray(response.content)
            ? response.content.map(c => typeof c === 'string' ? c : '').join('').trim()
            : '';
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
      
      if (generatedText && generatedText.length > 0) {
        logger.info("Generated comment with LLM", { 
          ...context,
          generatedLength: generatedText.length,
          attempt: attempt + 1,
          provider,
          model: modelName,
        });
        return generatedText;
      }
      
      logger.warn("Generated text invalid, will retry", { ...context, generatedText, attempt: attempt + 1 });
      lastError = new Error("Invalid generated text");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const delay = attempt < MAX_RETRIES - 1 ? INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt) : 0;
      logger.warn(`Attempt ${attempt + 1}/${MAX_RETRIES} failed${delay > 0 ? `, retrying in ${delay}ms` : ''}`, { 
        ...context,
        error: lastError.message,
        errorName: lastError.name,
        provider,
        model: modelName,
      });
    }
    
    // Wait before retry (exponential backoff)
    if (attempt < MAX_RETRIES - 1) {
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  
  logger.error("Failed to generate comment after all retries, using fallback", { 
    ...context,
    error: lastError?.message,
    errorName: lastError?.name,
    errorStack: lastError?.stack,
    provider,
    model: modelName,
    totalAttempts: MAX_RETRIES,
  });
  return fallbackMessage;
}
