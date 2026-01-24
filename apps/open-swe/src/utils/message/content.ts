import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  isAIMessage,
  isHumanMessage,
  isSystemMessage,
  isToolMessage,
  SystemMessage,
  ToolMessage,
  MessageContent,
} from "@langchain/core/messages";
import { ToolCall } from "@langchain/core/messages/tool";
import { getMessageContentString } from "@openswe/shared/messages";
import { v4 as uuidv4 } from "uuid";

export function getToolCallsString(toolCalls: ToolCall[] | undefined): string {
  if (!toolCalls?.length) return "";
  return toolCalls.map((c) => JSON.stringify(c, null, 2)).join("\n");
}

export function getAIMessageString(message: AIMessage): string {
  const content = getMessageContentString(message.content);
  const toolCalls = getToolCallsString(message.tool_calls);
  return `<assistant message-id=${message.id ?? "No ID"}>\nContent: ${content}\nTool calls: ${toolCalls}\n</assistant>`;
}

export function getHumanMessageString(message: HumanMessage): string {
  const content = getMessageContentString(message.content);
  return `<human message-id=${message.id ?? "No ID"}>\nContent: ${content}\n</human>`;
}

export function getToolMessageString(message: ToolMessage): string {
  const content = getMessageContentString(message.content);
  const toolCallId = message.tool_call_id;
  const toolCallName = message.name;
  const toolStatus = message.status || "success";

  return `<tool message-id=${message.id ?? "No ID"} status="${toolStatus}">\nTool Call ID: ${toolCallId}\nTool Call Name: ${toolCallName}\nContent: ${content}\n</tool>`;
}

export function getSystemMessageString(message: SystemMessage): string {
  const content = getMessageContentString(message.content);
  return `<system message-id=${message.id ?? "No ID"}>\nContent: ${content}\n</system>`;
}

export function getUnknownMessageString(message: BaseMessage): string {
  return `<unknown message-id=${message.id ?? "No ID"}>\n${JSON.stringify(message, null, 2)}\n</unknown>`;
}

export function getMessageString(message: BaseMessage): string {
  if (isAIMessage(message)) {
    return getAIMessageString(message);
  } else if (isHumanMessage(message)) {
    return getHumanMessageString(message);
  } else if (isToolMessage(message)) {
    return getToolMessageString(message);
  } else if (isSystemMessage(message)) {
    return getSystemMessageString(message);
  }

  return getUnknownMessageString(message);
}

export function filterMessagesWithoutContent(
  messages: BaseMessage[],
  filterHidden = true,
): BaseMessage[] {
  return messages.filter((m) => {
    if (filterHidden && m.additional_kwargs?.hidden) {
      return false;
    }
    const messageContentStr = getMessageContentString(m.content);
    if (!isAIMessage(m)) {
      return !!messageContentStr;
    }
    const toolCallsCount = m.tool_calls?.length || 0;
    return !!messageContentStr || toolCallsCount > 0;
  });
}

/**
 * Get the role of a message for Anthropic API.
 * - AIMessage -> "assistant"
 * - HumanMessage, ToolMessage -> "user"
 * - SystemMessage -> "system"
 */
export function getMessageRole(message: BaseMessage): "assistant" | "user" | "system" | "unknown" {
  if (isAIMessage(message)) {
    return "assistant";
  } else if (isHumanMessage(message) || isToolMessage(message)) {
    return "user";
  } else if (isSystemMessage(message)) {
    return "system";
  }
  return "unknown";
}

/**
 * Convert message content to array format for merging.
 */
function normalizeContentToArray(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content as Array<Record<string, unknown>>;
  }
  return [content as Record<string, unknown>];
}

/**
 * Convert ToolMessage content to Anthropic's tool_result format.
 * This preserves the tool_call_id as tool_use_id for Anthropic API compliance.
 */
function convertToolMessageToContentBlock(message: ToolMessage): Record<string, unknown> {
  const content = message.content;

  // If content is already in the right format (from previous processing), use it
  if (Array.isArray(content) && content.length > 0 &&
    typeof content[0] === 'object' && content[0] !== null &&
    'type' in content[0] && content[0].type === 'tool_result') {
    return content[0] as Record<string, unknown>;
  }

  // For array content (e.g., multi-part responses), pass as-is for SDK to process
  // For string content, pass directly
  // Anthropic API supports both string and array content in tool_result
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content: typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
        : String(content),
  };
}

/**
 * Normalize a message's content to array format, handling ToolMessage specially.
 */
function normalizeMessageContent(message: BaseMessage): Array<Record<string, unknown>> {
  if (isToolMessage(message)) {
    return [convertToolMessageToContentBlock(message as ToolMessage)];
  }
  return normalizeContentToArray(message.content);
}

/**
 * Merge consecutive messages with the same role for Anthropic API compliance.
 * Anthropic requires messages to alternate between "user" and "assistant" roles.
 * 
 * This function:
 * 1. Merges consecutive HumanMessages by combining their content arrays
 * 2. Merges consecutive ToolMessages into a single message with combined content
 *    (preserving tool_call_id as tool_use_id in tool_result format)
 * 3. Merges HumanMessage + ToolMessage by combining content (ToolMessage becomes tool_result)
 * 4. Merges consecutive AIMessages by combining their content and tool_calls
 * 5. Preserves system messages as-is (should only be at the start)
 */
export function mergeConsecutiveSameRoleMessages(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const result: BaseMessage[] = [];

  for (const msg of messages) {
    if (result.length === 0) {
      result.push(msg);
      continue;
    }

    const lastMsg = result[result.length - 1];
    const lastRole = getMessageRole(lastMsg);
    const currentRole = getMessageRole(msg);

    // Skip system messages - they should be at the start and handled separately
    if (currentRole === "system") {
      result.push(msg);
      continue;
    }

    // If different roles, just add the message
    if (lastRole !== currentRole) {
      result.push(msg);
      continue;
    }

    // Same role - need to merge
    if (currentRole === "user") {
      // Get content from both messages, properly handling ToolMessage
      const lastContent = normalizeMessageContent(lastMsg);
      const currentContent = normalizeMessageContent(msg);
      const mergedContent = [...lastContent, ...currentContent];

      // Create new HumanMessage with merged content
      const mergedMessage = new HumanMessage({
        id: lastMsg.id || uuidv4(),
        content: mergedContent,
        additional_kwargs: {
          ...lastMsg.additional_kwargs,
          ...msg.additional_kwargs,
          merged_message_count: ((lastMsg.additional_kwargs?.merged_message_count as number) || 1) + 1,
        },
      });

      result[result.length - 1] = mergedMessage;
    } else if (currentRole === "assistant") {
      // Merge assistant messages (AIMessage)
      const lastAIMsg = lastMsg as AIMessage;
      const currentAIMsg = msg as AIMessage;

      const mergedContent = [
        ...normalizeContentToArray(lastAIMsg.content),
        ...normalizeContentToArray(currentAIMsg.content),
      ];
      const mergedToolCalls = [
        ...(lastAIMsg.tool_calls || []),
        ...(currentAIMsg.tool_calls || []),
      ];

      const mergedMessage = new AIMessage({
        id: lastAIMsg.id || uuidv4(),
        content: mergedContent,
        tool_calls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
        additional_kwargs: {
          ...lastAIMsg.additional_kwargs,
          ...currentAIMsg.additional_kwargs,
          merged_message_count: ((lastAIMsg.additional_kwargs?.merged_message_count as number) || 1) + 1,
        },
        response_metadata: {
          ...lastAIMsg.response_metadata,
          ...currentAIMsg.response_metadata,
        },
      });

      result[result.length - 1] = mergedMessage;
    } else {
      // Unknown role - just add
      result.push(msg);
    }
  }

  return result;
}
