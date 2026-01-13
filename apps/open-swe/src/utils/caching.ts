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
    if ("cache_control" in messageContent[messageContent.length - 1]) {
      // Already set, no-op
      return messageContent;
    }

    const newMessageContent = [...messageContent];
    newMessageContent[newMessageContent.length - 1] = {
      ...newMessageContent[newMessageContent.length - 1],
      cache_control: { type: "ephemeral" },
    };
    return newMessageContent;
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
function ensureThinkingBlockFirst(content: MessageContent): MessageContent {
  if (typeof content === "string") {
    // String content - no thinking block needed for simple responses
    return content;
  }

  if (!Array.isArray(content) || content.length === 0) {
    return content;
  }

  // Check if first element is already a thinking block
  const firstBlock = content[0] as Record<string, unknown>;
  if (firstBlock && (firstBlock.type === "thinking" || firstBlock.type === "redacted_thinking")) {
    return content;
  }

  // Check if there are any tool_use blocks - if so, we need a thinking block first
  const hasToolUse = content.some((block: unknown) => {
    const b = block as Record<string, unknown>;
    return b && b.type === "tool_use";
  });

  if (hasToolUse) {
    // Add a placeholder redacted_thinking block at the beginning
    // Using redacted_thinking is safer as it doesn't require valid signature
    const thinkingBlock = {
      type: "thinking",
      thinking: "(Thinking content not available for this historical message)",
      // We need to provide a valid signature for thinking blocks
      // Using a placeholder that indicates this is a reconstructed message
      signature: "reconstructed",
    };
    return [thinkingBlock, ...content];
  }

  return content;
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
      content: addCacheControlToMessageContent(
        (message as ToolMessage).content,
      ),
    });
  } else {
    return message;
  }
}

/**
 * Converts AIMessage to have proper thinking block order for Anthropic's thinking mode.
 * This ensures all assistant messages have thinking blocks as the first content element.
 */
function convertToThinkingAwareMessage(message: BaseMessage): BaseMessage {
  if (isAIMessage(message)) {
    return new AIMessage({
      ...message,
      content: ensureThinkingBlockFirst(message.content),
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
): BaseMessage[] {
  return messages.map(convertToThinkingAwareMessage);
}

export function convertMessagesToCacheControlledMessages(
  messages: BaseMessage[],
  options?: { thinkingMode?: boolean },
) {
  if (messages.length === 0) {
    return messages;
  }

  // First, ensure thinking blocks are properly ordered if in thinking mode
  let processedMessages = options?.thinkingMode
    ? messages.map(convertToThinkingAwareMessage)
    : [...messages];

  const lastIndex = processedMessages.length - 1;
  processedMessages[lastIndex] = convertToCacheControlMessage(processedMessages[lastIndex]);
  return processedMessages;
}
