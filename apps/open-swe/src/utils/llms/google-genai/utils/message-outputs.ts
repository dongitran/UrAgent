/**
 * Message Output Conversion Utilities
 * 
 * Converts Google GenAI responses to LangChain format.
 * CRITICAL: This module captures thoughtSignature from Google API response
 * and stores it in AIMessage.response_metadata for later reinject.
 */

import {
  AIMessage,
  AIMessageChunk,
  type MessageContent,
  type UsageMetadata as LangChainUsageMetadata,
} from "@langchain/core/messages";
import { ToolCallChunk } from "@langchain/core/messages/tool";
import { ChatGeneration, ChatGenerationChunk } from "@langchain/core/outputs";
import { v4 as uuidv4 } from "uuid";
import {
  FunctionCall,
  GenerateContentResponse,
  UsageMetadata as GoogleUsageMetadata,
  PartWithThoughtSignature,
} from "../types.js";

// Debug flag - controlled via GEMINI_DEBUG env var
const GEMINI_DEBUG = process.env.GEMINI_DEBUG === 'true';

function debugLog(message: string, data?: Record<string, unknown>) {
  if (GEMINI_DEBUG) {
    console.error(`[Gemini Debug] ${message}`, data ?? {});
  }
}

/**
 * Extracts usage metadata from Google's format to LangChain's format.
 */
function extractUsageMetadata(
  usage?: GoogleUsageMetadata
): LangChainUsageMetadata | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokenCount ?? 0,
    output_tokens: usage.responseTokenCount ?? 0,
    total_tokens: usage.totalTokenCount ?? 0,
  };
}

/**
 * Converts a Google FunctionCall to a LangChain ToolCallChunk.
 */
function convertFunctionCallToToolCallChunk(
  fc: FunctionCall,
  index: number
): ToolCallChunk {
  return {
    name: fc.name ?? "",
    args: JSON.stringify(fc.args),
    id: (fc as any).id ?? uuidv4(), // Generate ID if missing
    index,
    type: "tool_call_chunk",
  };
}

/**
 * Validates that a thoughtSignature is a single valid Base64 string.
 * Detects concatenated signatures (which have '=' padding in the middle).
 * 
 * @returns The last valid signature if concatenated, or the original if valid
 */
function validateAndFixThoughtSignature(signature: string): string | undefined {
  if (!signature || typeof signature !== 'string') {
    return undefined;
  }

  // Check for concatenated signatures - look for '=' followed by more Base64 chars
  // Valid Base64 ends with 0-2 '=' padding, so '=E' or '=A' etc in middle means concatenation
  const concatenationPattern = /=+[A-Za-z0-9+/]/;
  
  if (concatenationPattern.test(signature)) {
    debugLog(`DETECTED CONCATENATED SIGNATURES!`, {
      signatureLength: signature.length,
      signaturePreview: signature.slice(0, 100) + '...',
    });
    
    // Split by '=' padding followed by uppercase letter (start of new signature)
    // Take the LAST signature (most recent one)
    const parts = signature.split(/(?<==)(?=[A-Z])/);
    if (parts.length > 1) {
      const lastSignature = parts[parts.length - 1];
      debugLog(`Extracted last signature from ${parts.length} concatenated parts`, {
        lastSignaturePreview: lastSignature.slice(0, 50) + '...',
      });
      return lastSignature;
    }
  }
  
  return signature;
}

/**
 * Converts a single Google Part to an AIMessageChunk.
 * CRITICAL: Captures thoughtSignature into response_metadata
 * 
 * NOTE: We use a special key '_thoughtSignature' to prevent LangChain's
 * AIMessageChunk.concat() from merging/concatenating signatures.
 * The final signature extraction happens in convertGoogleStreamChunkToLangChainChunk.
 */
function convertPartToChunk(
  part: PartWithThoughtSignature,
  index: number
): AIMessageChunk {
  const responseMetadata: Record<string, unknown> = {};

  // =========================================================================
  // CRITICAL: Capture Thought Signature from Google API response
  // This will be stored in response_metadata and reinjected in the next request
  // 
  // We store it with validation to prevent concatenated signatures
  // =========================================================================
  if (part.thoughtSignature) {
    const validatedSignature = validateAndFixThoughtSignature(part.thoughtSignature);
    if (validatedSignature) {
      responseMetadata["thoughtSignature"] = validatedSignature;
      debugLog(`convertPartToChunk: Captured thoughtSignature`, {
        partIndex: index,
        hasFunctionCall: !!part.functionCall,
        functionCallName: part.functionCall?.name,
        hasText: !!part.text,
        signaturePreview: validatedSignature.slice(0, 50) + '...',
        wasFixed: validatedSignature !== part.thoughtSignature,
      });
    }
  }

  if (part.text !== undefined) {
    // If 'thought' is true, return it as a reasoning content block
    if (part.thought) {
      return new AIMessageChunk({
        content: [{ type: "reasoning", reasoning: part.text, index: 0 }],
        response_metadata: responseMetadata,
      });
    }

    return new AIMessageChunk({
      content: part.text,
      response_metadata: responseMetadata,
    });
  }

  if (part.functionCall !== undefined) {
    return new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        convertFunctionCallToToolCallChunk(part.functionCall, index),
      ],
      response_metadata: responseMetadata,
    });
  }

  // If we only have metadata (e.g. just a signature update)
  if (Object.keys(responseMetadata).length > 0) {
    return new AIMessageChunk({
      content: "",
      response_metadata: responseMetadata,
    });
  }

  return new AIMessageChunk({ content: "" });
}

/**
 * Processes a stream chunk from Google GenAI and converts it to a ChatGenerationChunk.
 * 
 * IMPORTANT: This function handles thoughtSignature carefully to prevent concatenation
 * issues when LangChain's AIMessageChunk.concat() merges response_metadata.
 */
export function convertGoogleStreamChunkToLangChainChunk(
  response: GenerateContentResponse
): ChatGenerationChunk | null {
  const candidate = response.candidates?.[0];
  if (!candidate) {
    // It might be a pure usage metadata chunk at the end
    if (response.usageMetadata) {
      return new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: "",
          usage_metadata: extractUsageMetadata(response.usageMetadata),
        }),
        text: "",
      });
    }
    return null;
  }

  const parts = candidate.content?.parts as PartWithThoughtSignature[] | undefined;
  
  // Debug: Log if any part has thoughtSignature
  const partsWithSignature = parts?.filter(p => p.thoughtSignature) ?? [];
  if (partsWithSignature.length > 0) {
    debugLog(`Stream chunk has thoughtSignature`, {
      partsCount: parts?.length ?? 0,
      partsWithSignatureCount: partsWithSignature.length,
      signaturePreview: partsWithSignature[0]?.thoughtSignature?.slice(0, 50) + '...',
      hasFunctionCall: parts?.some(p => p.functionCall) ?? false,
    });
  }

  // Convert parts to chunks, but handle thoughtSignature specially
  // We need to ensure only ONE signature survives (the last one from this response)
  let lastSignatureFromParts: string | undefined;
  
  const chunk = parts?.reduce(
    (acc: AIMessageChunk | null, part, index) => {
      // Capture the signature before converting (we'll handle it separately)
      if (part.thoughtSignature) {
        const validated = validateAndFixThoughtSignature(part.thoughtSignature);
        if (validated) {
          lastSignatureFromParts = validated;
        }
      }
      
      const nextChunk = convertPartToChunk(part, index);
      
      if (!acc) return nextChunk;
      
      // Custom concat that preserves the LAST thoughtSignature instead of concatenating
      const concatenated = acc.concat(nextChunk);
      
      return concatenated;
    },
    null
  );

  if (!chunk) return null;

  // CRITICAL: Override the response_metadata.thoughtSignature with the validated last signature
  // This prevents concatenation issues from LangChain's default merge behavior
  if (lastSignatureFromParts) {
    // Create new response_metadata with the correct signature
    const newMetadata = { ...chunk.response_metadata };
    newMetadata["thoughtSignature"] = lastSignatureFromParts;
    
    // We need to create a new chunk with the corrected metadata
    // because AIMessageChunk is immutable
    const correctedChunk = new AIMessageChunk({
      content: chunk.content,
      tool_call_chunks: chunk.tool_call_chunks,
      response_metadata: newMetadata,
      usage_metadata: chunk.usage_metadata,
    });
    
    debugLog(`Chunk response_metadata has thoughtSignature (corrected)`, {
      signaturePreview: lastSignatureFromParts.slice(0, 50) + '...',
      hasToolCalls: (correctedChunk.tool_call_chunks?.length ?? 0) > 0,
      toolCallNames: correctedChunk.tool_call_chunks?.map(tc => tc.name) ?? [],
    });

    // Determine text content for the chunk
    let chunkText = "";
    if (typeof correctedChunk.content === "string") {
      chunkText = correctedChunk.content;
    } else if (Array.isArray(correctedChunk.content)) {
      chunkText = correctedChunk.content
        .filter((block: any) => block.type === "text" && "text" in block)
        .map((block: any) => block.text)
        .join("");
    }

    return new ChatGenerationChunk({
      message: correctedChunk,
      text: chunkText,
    });
  }

  // Attach usage metadata if present in this chunk
  if (response.usageMetadata) {
    chunk.usage_metadata = extractUsageMetadata(response.usageMetadata);
  }

  // Debug: Log if chunk has thoughtSignature in response_metadata
  if (chunk.response_metadata?.thoughtSignature) {
    // Validate and fix any concatenated signatures
    const existingSignature = chunk.response_metadata.thoughtSignature as string;
    const validatedSignature = validateAndFixThoughtSignature(existingSignature);
    
    if (validatedSignature && validatedSignature !== existingSignature) {
      debugLog(`Fixed concatenated signature in chunk`, {
        originalLength: existingSignature.length,
        fixedLength: validatedSignature.length,
      });
      chunk.response_metadata["thoughtSignature"] = validatedSignature;
    }
    
    debugLog(`Chunk response_metadata has thoughtSignature`, {
      signaturePreview: (chunk.response_metadata.thoughtSignature as string).slice(0, 50) + '...',
      hasToolCalls: (chunk.tool_call_chunks?.length ?? 0) > 0,
      toolCallNames: chunk.tool_call_chunks?.map(tc => tc.name) ?? [],
    });
  }

  // Determine text content for the chunk
  let chunkText = "";
  if (typeof chunk.content === "string") {
    chunkText = chunk.content;
  } else if (Array.isArray(chunk.content)) {
    chunkText = chunk.content
      .filter((block: any) => block.type === "text" && "text" in block)
      .map((block: any) => block.text)
      .join("");
  }

  return new ChatGenerationChunk({
    message: chunk,
    text: chunkText,
  });
}

/**
 * Converts a full non-streaming Google GenAI response to a ChatGeneration.
 * CRITICAL: Captures thoughtSignature into response_metadata
 */
export function convertGoogleResponseToChatGeneration(
  response: GenerateContentResponse
): ChatGeneration {
  const candidate = response.candidates?.[0];
  if (!candidate || !candidate.content) {
    throw new Error("No candidates returned from Google GenAI.");
  }

  let textContent = "";
  const contentBlocks: MessageContent = [];
  const toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    id: string;
    type: "tool_call";
  }> = [];
  const responseMetadata: Record<string, unknown> = {
    finishReason: candidate.finishReason,
    index: candidate.index,
    ...(response.promptFeedback || {}), // Include safety feedback
  };

  const parts = candidate.content.parts as PartWithThoughtSignature[] | undefined;
  if (parts) {
    for (const part of parts) {
      if (part.text) {
        if (part.thought) {
          // It's a reasoning block
          contentBlocks.push({ type: "reasoning", reasoning: part.text });

          // Also accumulate in metadata for legacy access/convenience
          const existingThoughts =
            (responseMetadata["thoughts"] as string[]) || [];
          existingThoughts.push(part.text || "");
          responseMetadata["thoughts"] = existingThoughts;
        } else {
          // It's standard text
          textContent += part.text;
          contentBlocks.push({ type: "text", text: part.text });
        }
      }

      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name ?? "",
          args: (part.functionCall.args as Record<string, unknown>) ?? {},
          id: (part.functionCall as any).id ?? uuidv4(),
          type: "tool_call" as const,
        });
      }

      // =========================================================================
      // CRITICAL: Capture Thought Signature from Google API response
      // This is stored in response_metadata and will be reinjected in next request
      // Validate to prevent concatenated signatures
      // =========================================================================
      if (part.thoughtSignature) {
        const validatedSignature = validateAndFixThoughtSignature(part.thoughtSignature);
        if (validatedSignature) {
          responseMetadata["thoughtSignature"] = validatedSignature;
        }
      }

      // Handle Code Execution
      if (part.executableCode) {
        responseMetadata["executableCode"] = part.executableCode;
      }
      if (part.codeExecutionResult) {
        responseMetadata["codeExecutionResult"] = part.codeExecutionResult;
      }
    }
  }

  // If we have reasoning blocks, return content as an array of blocks.
  // Otherwise, return simple string for better compatibility with standard chains.
  const hasReasoning = contentBlocks.some((b: any) => b.type === "reasoning");
  const finalContent = hasReasoning ? contentBlocks : textContent;

  const msg = new AIMessage({
    content: finalContent,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    response_metadata: responseMetadata,
    usage_metadata: extractUsageMetadata(response.usageMetadata),
  });

  return {
    text: textContent,
    message: msg,
    generationInfo: {
      finishReason: candidate.finishReason,
      index: candidate.index,
    },
  };
}
