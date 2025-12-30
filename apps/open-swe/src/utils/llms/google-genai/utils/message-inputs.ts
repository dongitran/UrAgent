/**
 * Message Input Conversion Utilities
 * 
 * Converts LangChain messages to Google GenAI format.
 * CRITICAL: This module handles the reinject of thoughtSignature from AIMessage metadata
 * which is required for Gemini 3 function calling to work correctly.
 */

import {
  type BaseMessage,
  type MessageContent,
  isAIMessage,
  isSystemMessage,
  isToolMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { Content, PartWithThoughtSignature } from "../types.js";

/**
 * Validates that a thoughtSignature is a single valid Base64 string.
 * Detects concatenated signatures (which have '=' padding in the middle).
 * 
 * @returns The last valid signature if concatenated, or the original if valid, or undefined if invalid
 */
function validateAndFixThoughtSignature(signature: unknown): string | undefined {
  if (!signature || typeof signature !== 'string') {
    return undefined;
  }

  // Check for concatenated signatures - look for '=' followed by more Base64 chars
  // Valid Base64 ends with 0-2 '=' padding, so '=E' or '=A' etc in middle means concatenation
  const concatenationPattern = /=+[A-Za-z0-9+/]/;
  
  if (concatenationPattern.test(signature)) {
    console.error(`[Gemini Debug] message-inputs: DETECTED CONCATENATED SIGNATURES!`, {
      signatureLength: signature.length,
      signaturePreview: signature.slice(0, 100) + '...',
    });
    
    // Split by '=' padding followed by uppercase letter (start of new signature)
    // Take the LAST signature (most recent one)
    const parts = signature.split(/(?<==)(?=[A-Z])/);
    if (parts.length > 1) {
      const lastSignature = parts[parts.length - 1];
      console.error(`[Gemini Debug] message-inputs: Extracted last signature from ${parts.length} concatenated parts`, {
        lastSignaturePreview: lastSignature.slice(0, 50) + '...',
      });
      return lastSignature;
    }
  }
  
  return signature;
}

/**
 * Helper to parse a base64 data URL into mimeType and data.
 */
function parseBase64Data(dataUrl: string): { mimeType: string; data: string } {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Invalid base64 image data URL");
  }
  return { mimeType: matches[1], data: matches[2] };
}

/**
 * Converts a LangChain MessageContent (string or complex array) into Google Parts.
 */
function convertContentToParts(content: MessageContent): PartWithThoughtSignature[] {
  if (typeof content === "string") {
    if (content === "") return [];
    return [{ text: content }];
  }

  return content.map((block): PartWithThoughtSignature => {
    const b = block as {
      type: string;
      text?: string;
      image_url?: string | { url: string };
      reasoning?: string;
    };

    if (b.type === "text" && typeof b.text === "string") {
      return { text: b.text };
    } else if (b.type === "reasoning" && typeof b.reasoning === "string") {
      // Convert LangChain reasoning block back to Google thought part
      return { text: b.reasoning, thought: true };
    } else if (b.type === "image_url" && b.image_url) {
      let url: string;
      if (typeof b.image_url === "string") {
        url = b.image_url;
      } else if (typeof b.image_url === "object" && "url" in b.image_url) {
        url = b.image_url.url;
      } else {
        throw new Error("Invalid image_url block format");
      }

      // Handle Base64
      if (url.startsWith("data:")) {
        const { mimeType, data } = parseBase64Data(url);
        return {
          inlineData: {
            mimeType,
            data,
          },
        };
      }
      // Handle File URI (Google Cloud Storage or File API)
      else if (url.startsWith("gs://") || url.startsWith("https://")) {
        return {
          fileData: {
            mimeType: "image/jpeg", // Fallback, ideally should be inferred
            fileUri: url,
          },
        };
      }
    }
    // Skip unknown block types or throw error depending on strictness.
    throw new Error(`Unsupported content block type: ${b.type}`);
  });
}

/**
 * Converts a LangChain ToolCall to a Google FunctionCall Part.
 */
function convertToolCallToPart(toolCall: ToolCall): PartWithThoughtSignature {
  return {
    functionCall: {
      name: toolCall.name,
      args: toolCall.args,
    },
  };
}

/**
 * Converts a LangChain ToolMessage to a Google FunctionResponse Part.
 * 
 * Google GenAI API requires functionResponse.response to be an object.
 * The response should use "output" key for function output or "error" key for errors.
 * If neither is specified, the whole response object is treated as function output.
 * 
 * @param message - The ToolMessage to convert
 * @param toolCallIdToNameMap - Optional map from tool_call_id to tool name (for fallback)
 */
function convertToolMessageToPart(
  message: BaseMessage, 
  toolCallIdToNameMap?: Map<string, string>
): PartWithThoughtSignature {
  // Parse content if it's a string that looks like JSON
  let responseContent: unknown = message.content;
  if (typeof message.content === "string") {
    try {
      responseContent = JSON.parse(message.content);
    } catch {
      // Keep as string if not valid JSON
      responseContent = message.content;
    }
  }

  // Google API requires response to be an object
  // If responseContent is not an object, wrap it in { output: ... }
  let responseObject: Record<string, unknown>;
  
  if (responseContent === null || responseContent === undefined) {
    responseObject = { output: null };
  } else if (typeof responseContent === "object" && !Array.isArray(responseContent)) {
    // Already an object, use as-is
    responseObject = responseContent as Record<string, unknown>;
  } else {
    // Wrap primitive values or arrays in { output: ... }
    responseObject = { output: responseContent };
  }

  // Get tool name - try multiple sources
  let toolName = (message as any).name;
  
  // If name is not set, try to get it from tool_call_id map
  if (!toolName && toolCallIdToNameMap) {
    const toolCallId = (message as any).tool_call_id;
    if (toolCallId) {
      toolName = toolCallIdToNameMap.get(toolCallId);
    }
  }

  // If still no name, use a fallback (this shouldn't happen in normal flow)
  if (!toolName) {
    console.error(`[Gemini Debug] WARNING: ToolMessage has no name!`, {
      tool_call_id: (message as any).tool_call_id,
      contentPreview: typeof message.content === 'string' 
        ? message.content.slice(0, 100) 
        : JSON.stringify(message.content).slice(0, 100),
    });
    // Use "unknown_tool" as fallback - Google API requires non-empty name
    toolName = "unknown_tool";
  }

  return {
    functionResponse: {
      name: toolName,
      response: responseObject,
    },
  };
}

/**
 * Main function to convert LangChain messages to Google GenAI payload.
 * Handles merging consecutive messages of the same role.
 * 
 * CRITICAL: This function reinjects thoughtSignature from AIMessage.response_metadata
 * into the Google API request. This is REQUIRED for Gemini 3 function calling.
 */
export function convertMessagesToGooglePayload(messages: BaseMessage[]): {
  contents: Content[];
  systemInstruction?: Content;
} {
  const contents: Content[] = [];
  let systemInstruction: Content | undefined;

  // 1. Extract System Messages
  const systemMessages: BaseMessage[] = [];
  const chatMessages: BaseMessage[] = [];
  
  for (const msg of messages) {
    if (isSystemMessage(msg)) {
      systemMessages.push(msg);
    } else {
      chatMessages.push(msg);
    }
  }
  
  if (systemMessages.length > 0) {
    const systemParts = systemMessages.flatMap((msg) =>
      convertContentToParts(msg.content)
    );
    if (systemParts.length > 0) {
      systemInstruction = {
        role: "user", // System instruction uses 'user' role in Google API
        parts: systemParts,
      };
    }
  }

  // Build a map from tool_call_id to tool name for ToolMessage name resolution
  const toolCallIdToNameMap = new Map<string, string>();
  for (const msg of chatMessages) {
    if (isAIMessage(msg) && msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.id && toolCall.name) {
          toolCallIdToNameMap.set(toolCall.id, toolCall.name);
        }
      }
    }
  }

  console.error(`[Gemini Debug] convertMessagesToGooglePayload`, {
    totalMessages: messages.length,
    systemMessagesCount: systemMessages.length,
    chatMessagesCount: chatMessages.length,
    toolCallIdToNameMapSize: toolCallIdToNameMap.size,
    chatMessageTypes: chatMessages.map((m, i) => {
      const metadata = isAIMessage(m) ? (m.response_metadata as Record<string, unknown> | undefined) : undefined;
      return {
        index: i,
        type: m._getType(),
        isAI: isAIMessage(m),
        isTool: isToolMessage(m),
        hasToolCalls: isAIMessage(m) ? (m.tool_calls?.length ?? 0) : 0,
        name: (m as any).name,
        tool_call_id: (m as any).tool_call_id,
        hasThoughtSignature: !!metadata?.thoughtSignature,
        thoughtSignaturePreview: metadata?.thoughtSignature 
          ? (metadata.thoughtSignature as string).slice(0, 30) + '...' 
          : undefined,
      };
    }),
  });

  // 2. Process Non-System Messages
  for (let i = 0; i < chatMessages.length; i++) {
    const message = chatMessages[i];
    const role = isAIMessage(message) ? "model" : "user";
    const parts: PartWithThoughtSignature[] = [];

    // Handle Content (Text/Images/Reasoning)
    parts.push(...convertContentToParts(message.content));

    // Handle Tool Calls (AI Message)
    if (isAIMessage(message)) {
      // =========================================================================
      // CRITICAL: Get thoughtSignature from AIMessage metadata BEFORE adding parts
      // This is REQUIRED for Gemini 3 function calling to work correctly.
      // We validate the signature to prevent concatenated signatures from being sent
      // =========================================================================
      const metadata = message.response_metadata as Record<string, unknown> | undefined;
      const rawSignature = metadata?.["thoughtSignature"];
      const thoughtSignature = validateAndFixThoughtSignature(rawSignature);
      
      if (rawSignature && !thoughtSignature) {
        console.error(`[Gemini Debug] WARNING: Invalid thoughtSignature detected and removed`, {
          rawSignatureType: typeof rawSignature,
        });
      } else if (thoughtSignature && rawSignature !== thoughtSignature) {
        console.error(`[Gemini Debug] Fixed concatenated signature in message-inputs`, {
          originalLength: (rawSignature as string).length,
          fixedLength: thoughtSignature.length,
        });
      }

      if (message.tool_calls && message.tool_calls.length > 0) {
        // =========================================================================
        // IMPORTANT: For Gemini 3, we need to handle signatures carefully.
        // 
        // According to Google docs:
        // - Parallel function calls: Only FIRST functionCall has signature
        // - Sequential function calls: Each AIMessage has its own signature
        // 
        // The key insight is:
        // - When model returns parallel FCs: "FC1 + signature, FC2" (no sig on FC2)
        // - When sending back: Must preserve same structure
        // 
        // So we should:
        // - If real signature exists: attach to FIRST FC only
        // - If no signature (synthetic AIMessage): attach dummy to FIRST FC only
        // =========================================================================
        for (let tcIndex = 0; tcIndex < message.tool_calls.length; tcIndex++) {
          const toolCall = message.tool_calls[tcIndex];
          const fcPart = convertToolCallToPart(toolCall);
          
          // Only attach signature to the FIRST functionCall (parallel FC behavior)
          if (tcIndex === 0) {
            if (thoughtSignature) {
              fcPart.thoughtSignature = thoughtSignature;
              console.error(`[Gemini Debug] Attached real thoughtSignature to first functionCall`, {
                messageIndex: i,
                toolCallIndex: tcIndex,
                toolName: toolCall.name,
                signaturePreview: thoughtSignature.slice(0, 50) + '...',
              });
            } else {
              // No signature - attach dummy signature to FIRST functionCall only
              fcPart.thoughtSignature = "skip_thought_signature_validator";
              console.error(`[Gemini Debug] Attached dummy signature to first functionCall`, {
                messageIndex: i,
                toolCallIndex: tcIndex,
                toolName: toolCall.name,
                dummySignature: "skip_thought_signature_validator",
              });
            }
          } else {
            // Subsequent parallel FCs should NOT have signature
            console.error(`[Gemini Debug] No signature for parallel functionCall (index > 0)`, {
              messageIndex: i,
              toolCallIndex: tcIndex,
              toolName: toolCall.name,
            });
          }
          
          parts.push(fcPart);
        }
      }
      
      // If no tool calls but has signature (e.g., text response with signature)
      // attach to the last text part or create a dummy part
      if ((!message.tool_calls || message.tool_calls.length === 0) && thoughtSignature) {
        if (parts.length > 0) {
          parts[parts.length - 1].thoughtSignature = thoughtSignature;
        } else {
          parts.push({ text: "", thoughtSignature });
        }
      }
    }

    // Handle Tool Results (Tool Message)
    // Note: ToolMessages are mapped to 'user' role in Google GenAI
    if (isToolMessage(message)) {
      const toolPart = convertToolMessageToPart(message, toolCallIdToNameMap);
      console.error(`[Gemini Debug] Converting ToolMessage ${i}`, {
        name: (message as any).name,
        tool_call_id: (message as any).tool_call_id,
        resolvedName: (toolPart.functionResponse as any)?.name,
        contentType: typeof message.content,
        contentPreview: typeof message.content === 'string' 
          ? message.content.slice(0, 200) 
          : JSON.stringify(message.content).slice(0, 200),
        convertedPart: JSON.stringify(toolPart).slice(0, 500),
      });
      parts.push(toolPart);
    }

    // Merge logic: If the last message in `contents` has the same role, append parts.
    // CRITICAL: For AIMessages with tool_calls, we need special handling to ensure
    // each "batch" of functionCalls has a signature on the first FC.
    const lastContent = contents[contents.length - 1];
    const currentHasFunctionCalls = parts.some(p => p.functionCall);

    if (lastContent && lastContent.role === role) {
      if (!lastContent.parts) {
        lastContent.parts = [];
      }
      
      // =========================================================================
      // CRITICAL: When merging AIMessages with functionCalls, we need to ensure
      // that the first functionCall of each "batch" (from each original AIMessage)
      // has a signature. This is because Google API expects:
      // - Sequential FCs: Each AIMessage's first FC has signature
      // - Parallel FCs: Only first FC has signature
      // 
      // When we merge, we're combining sequential AIMessages, so each batch's
      // first FC should have a signature.
      // =========================================================================
      
      // Check if we're merging functionCalls into existing content that already has functionCalls
      const existingHasFunctionCalls = lastContent.parts.some(p => (p as PartWithThoughtSignature).functionCall);
      
      if (currentHasFunctionCalls && existingHasFunctionCalls) {
        // We're merging functionCalls from different AIMessages
        // The first FC of the new batch should already have signature (attached above)
        // Just verify and log
        const firstNewFC = parts.find(p => p.functionCall);
        if (firstNewFC && !firstNewFC.thoughtSignature) {
          console.error(`[Gemini Debug] ⚠️ WARNING: Merging FCs but first new FC has no signature!`, {
            contentIndex: contents.length - 1,
            existingPartsCount: lastContent.parts.length,
            newPartsCount: parts.length,
            firstNewFCName: firstNewFC.functionCall?.name,
          });
          // Add dummy signature to prevent validation error
          firstNewFC.thoughtSignature = "skip_thought_signature_validator";
        }
      }
      
      console.error(`[Gemini Debug] MERGING parts into existing content`, {
        contentIndex: contents.length - 1,
        existingPartsCount: lastContent.parts.length,
        newPartsCount: parts.length,
        role,
        messageIndex: i,
        messageType: message.constructor.name,
        hasToolCalls: isAIMessage(message) ? (message.tool_calls?.length ?? 0) : 0,
        newPartsHaveFunctionCall: currentHasFunctionCalls,
        existingHasFunctionCalls,
        newPartsWithSignature: parts.filter(p => p.thoughtSignature).length,
      });
      
      lastContent.parts.push(...parts);
    } else {
      contents.push({
        role,
        parts,
      });
    }
  }

  // =========================================================================
  // FINAL VALIDATION: Ensure ALL functionCall parts have signatures
  // 
  // According to Google docs:
  // - For parallel FCs in same response: Only FIRST FC has signature
  // - For sequential FCs from different responses: Each "batch" has signature on first FC
  // - Dummy signatures ("skip_thought_signature_validator") can be used to skip validation
  // 
  // The key insight from Google FAQ:
  // "you can set dummy signatures to skip validation" - this means we CAN add
  // dummy signatures to ALL FCs that don't have real signatures.
  // 
  // After merging, we CANNOT track which FCs came from which original AIMessage.
  // So we use a SAFE approach: add dummy signature to EVERY FC without signature.
  // 
  // This is safe because:
  // 1. Google API accepts dummy signatures
  // 2. Having extra signatures doesn't break anything
  // 3. Missing signatures WILL break the API call
  // =========================================================================
  for (let cIdx = 0; cIdx < contents.length; cIdx++) {
    const content = contents[cIdx];
    if (content.role !== "model" || !content.parts) continue;
    
    for (let pIdx = 0; pIdx < content.parts.length; pIdx++) {
      const part = content.parts[pIdx] as PartWithThoughtSignature;
      
      if (part.functionCall && !part.thoughtSignature) {
        // This FC doesn't have signature - add dummy
        part.thoughtSignature = "skip_thought_signature_validator";
        console.error(`[Gemini Debug] FINAL VALIDATION: Added dummy signature to FC without signature`, {
          contentIndex: cIdx,
          partIndex: pIdx,
          functionName: part.functionCall.name,
        });
      }
    }
  }

  // =========================================================================
  // DETAILED DEBUG: Log the final contents structure to identify missing signatures
  // =========================================================================
  console.error(`[Gemini Debug] convertMessagesToGooglePayload FINAL CONTENTS STRUCTURE:`);
  for (let cIdx = 0; cIdx < contents.length; cIdx++) {
    const content = contents[cIdx];
    console.error(`[Gemini Debug] contents[${cIdx}] role=${content.role}, parts=${content.parts?.length ?? 0}`);
    
    if (content.parts) {
      for (let pIdx = 0; pIdx < content.parts.length; pIdx++) {
        const part = content.parts[pIdx] as PartWithThoughtSignature;
        const partInfo: Record<string, unknown> = {
          contentIndex: cIdx,
          partIndex: pIdx,
        };
        
        if (part.text !== undefined) {
          partInfo.type = 'text';
          partInfo.textPreview = part.text.slice(0, 50);
          partInfo.thought = part.thought;
        }
        if (part.functionCall) {
          partInfo.type = 'functionCall';
          partInfo.functionName = part.functionCall.name;
          partInfo.hasThoughtSignature = !!part.thoughtSignature;
          partInfo.thoughtSignaturePreview = part.thoughtSignature 
            ? (part.thoughtSignature as string).slice(0, 30) + '...'
            : 'MISSING!';
          
          // CRITICAL: Check if this functionCall is missing signature
          if (!part.thoughtSignature) {
            console.error(`[Gemini Debug] ⚠️ MISSING SIGNATURE at contents[${cIdx}].parts[${pIdx}]`, {
              functionName: part.functionCall.name,
              role: content.role,
            });
          }
        }
        if (part.functionResponse) {
          partInfo.type = 'functionResponse';
          partInfo.functionName = (part.functionResponse as any).name;
        }
        
        // Only log functionCall parts for brevity
        if (part.functionCall) {
          console.error(`[Gemini Debug]   parts[${pIdx}]:`, partInfo);
        }
      }
    }
  }

  console.error(`[Gemini Debug] convertMessagesToGooglePayload result`, {
    contentsCount: contents.length,
    contentsRoles: contents.map(c => c.role),
    contentsPartsCount: contents.map(c => c.parts?.length ?? 0),
  });

  return {
    contents,
    systemInstruction,
  };
}
