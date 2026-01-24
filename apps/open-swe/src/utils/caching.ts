import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  isAIMessage,
  isHumanMessage,
  isToolMessage,
  MessageContent,
  ToolMessage,
} from "@langchain/core/messages";
import { CacheMetrics, ModelTokenData } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "./logger.js";
import { calculateCostSavings } from "@openswe/shared/caching";

const logger = createLogger(LogLevel.INFO, "Caching");

export interface CacheablePromptSegment {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export function trackCachePerformance(
  response: AIMessageChunk,
  model: string,
): ModelTokenData[] {
  const metrics: CacheMetrics = {
    cacheCreationInputTokens:
      response.usage_metadata?.input_token_details?.cache_creation || 0,
    cacheReadInputTokens:
      response.usage_metadata?.input_token_details?.cache_read || 0,
    inputTokens: response.usage_metadata?.input_tokens || 0,
    outputTokens: response.usage_metadata?.output_tokens || 0,
  };

  const totalInputTokens =
    metrics.cacheCreationInputTokens +
    metrics.cacheReadInputTokens +
    metrics.inputTokens;

  const cacheHitRate =
    totalInputTokens > 0 ? metrics.cacheReadInputTokens / totalInputTokens : 0;
  const costSavings = calculateCostSavings(metrics).totalSavings;

  logger.info("Cache Performance", {
    model,
    cacheHitRate: `${(cacheHitRate * 100).toFixed(2)}%`,
    costSavings: `$${costSavings.toFixed(4)}`,
    ...metrics,
  });

  return [
    {
      ...metrics,
      model,
    },
  ];
}

/**
 * Recursively strips cache_control from an object and its nested properties.
 * This is needed because cache_control can sometimes be added to nested objects.
 */
function recursivelyStripCacheControl(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip cache_control keys entirely
    if (key === "cache_control") {
      continue;
    }

    // Recursively process nested objects (but not arrays or null)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = recursivelyStripCacheControl(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      // For arrays, recursively process each object element
      result[key] = value.map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return recursivelyStripCacheControl(item as Record<string, unknown>);
        }
        return item;
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Strips cache_control from all thinking and redacted_thinking blocks.
 * Claude API does not allow cache_control on thinking blocks.
 * This function also recursively strips cache_control from nested objects
 * within thinking blocks to handle edge cases.
 */
function sanitizeAssistantContent(content: MessageContent): MessageContent {
  if (typeof content === "string" || !Array.isArray(content)) {
    return content;
  }

  return content.map((block) => {
    const b = block as Record<string, unknown>;
    if (b && (b.type === "thinking" || b.type === "redacted_thinking")) {
      // Remove cache_control from thinking blocks and any nested properties
      // First strip top-level cache_control
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cache_control, ...rest } = b;
      // Then recursively strip any nested cache_control
      return recursivelyStripCacheControl(rest) as typeof block;
    }
    return block;
  });
}

function addCacheControlToMessageContent(
  messageContent: MessageContent,
): MessageContent {
  if (typeof messageContent === "string") {
    return [
      {
        type: "text",
        text: messageContent,
        cache_control: { type: "ephemeral" },
      },
    ];
  } else if (Array.isArray(messageContent)) {
    // ALWAYS sanitize the content first to remove any stale cache_control on thinking blocks
    const sanitizedContent = sanitizeAssistantContent(messageContent) as any[];
    const newMessageContent = [...sanitizedContent];

    // Find the last non-thinking element to add cache_control
    // Claude API does not allow cache_control on thinking blocks
    for (let i = newMessageContent.length - 1; i >= 0; i--) {
      const block = newMessageContent[i] as Record<string, unknown>;
      const blockType = block?.type;

      // Skip thinking blocks
      if (blockType === "thinking" || blockType === "redacted_thinking") {
        continue;
      }

      // Already has cache_control, return as is (but sanitized)
      if ("cache_control" in block) {
        return newMessageContent;
      }

      // Add cache_control to this non-thinking element
      newMessageContent[i] = {
        ...block,
        cache_control: { type: "ephemeral" },
      };
      return newMessageContent;
    }

    // All elements are thinking blocks - don't add cache_control
    logger.warn(
      "All message content elements are thinking blocks, skipping cache_control",
    );
    return sanitizedContent;
  } else {
    logger.warn("Unknown message content type", { messageContent });
    return messageContent;
  }
}

/**
 * Ensures that AIMessage content has thinking block as the first element
 * when using Anthropic's extended thinking mode.
 *
 * Anthropic API requires: "If an assistant message contains any thinking blocks,
 * the first block must be `thinking` or `redacted_thinking`."
 *
 * This function adds a placeholder thinking block if the message doesn't have one.
 */
function ensureThinkingBlockFirst(
  content: MessageContent,
  options?: { thinkingMode?: boolean },
): MessageContent {
  const sanitizedContent = sanitizeAssistantContent(content);

  // If not in thinking mode, we only care about sanitization (stripping cache_control)
  // for assistant messages that might already have thinking blocks from history.
  if (!options?.thinkingMode) {
    return sanitizedContent;
  }

  if (
    typeof sanitizedContent === "string" ||
    !Array.isArray(sanitizedContent) ||
    sanitizedContent.length === 0
  ) {
    return sanitizedContent;
  }

  // Check if first element is already a thinking block
  const firstBlock = sanitizedContent[0] as Record<string, unknown>;
  if (
    firstBlock &&
    (firstBlock.type === "thinking" || firstBlock.type === "redacted_thinking")
  ) {
    return sanitizedContent;
  }

  // Check if there are any tool_use blocks - if so, we need a thinking block first
  const hasToolUse = sanitizedContent.some((block) => {
    const b = block as Record<string, unknown>;
    return b && b.type === "tool_use";
  });

  if (hasToolUse) {
    // Add a placeholder redacted_thinking block at the beginning
    // Using redacted_thinking is safer as it doesn't require valid signature
    const thinkingBlock = {
      type: "thinking" as const,
      thinking: "(Thinking content not available for this historical message)",
      // We need to provide a valid signature for thinking blocks
      // Using a placeholder that indicates this is a reconstructed message
      signature: "reconstructed",
    };
    return [thinkingBlock, ...sanitizedContent] as MessageContent;
  }

  return sanitizedContent;
}

function convertToCacheControlMessage(message: BaseMessage): BaseMessage {
  if (isAIMessage(message)) {
    return new AIMessage({
      ...message,
      content: addCacheControlToMessageContent(message.content),
    });
  } else if (isHumanMessage(message)) {
    return new HumanMessage({
      ...message,
      content: addCacheControlToMessageContent(message.content),
    });
  } else if (isToolMessage(message)) {
    return new ToolMessage({
      ...(message as ToolMessage),
      content: addCacheControlToMessageContent((message as ToolMessage).content),
    });
  } else {
    return message;
  }
}

/**
 * Converts AIMessage to have proper thinking block order for Anthropic's thinking mode.
 * This ensures all assistant messages have thinking blocks as the first content element.
 */
function convertToThinkingAwareMessage(
  message: BaseMessage,
  options?: { thinkingMode?: boolean },
): BaseMessage {
  if (isAIMessage(message)) {
    return new AIMessage({
      ...message,
      content: ensureThinkingBlockFirst(message.content, options),
    });
  }
  return message;
}

/**
 * Converts all messages to be thinking-aware for Anthropic's extended thinking mode.
 * This ensures all AIMessages have thinking blocks as the first content element.
 */
export function convertMessagesToThinkingAwareMessages(
  messages: BaseMessage[],
  options?: { thinkingMode?: boolean },
): BaseMessage[] {
  return messages.map((m) => convertToThinkingAwareMessage(m, options));
}

export function convertMessagesToCacheControlledMessages(
  messages: BaseMessage[],
  options?: { thinkingMode?: boolean },
) {
  if (messages.length === 0) {
    return messages;
  }

  // ALWAYS map through convertToThinkingAwareMessage to ensure:
  // 1. Thinking blocks are stripped of invalid cache_control (sanitization)
  // 2. Thinking blocks are properly ordered (if needed by thinkingMode flag in options)
  // Even if thinkingMode is false, the sanitization logic in ensureThinkingBlockFirst
  // will clean up any accidental thinking-cache-control from history.
  const processedMessages = messages.map((m) =>
    convertToThinkingAwareMessage(m, options),
  );

  const lastIndex = processedMessages.length - 1;
  processedMessages[lastIndex] = convertToCacheControlMessage(
    processedMessages[lastIndex],
  );
  return processedMessages;
}
