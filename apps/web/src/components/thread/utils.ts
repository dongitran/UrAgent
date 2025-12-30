import type { Message } from "@langchain/langgraph-sdk";

/**
 * Extracts a string summary from a message's content, supporting multimodal (text, image, file, etc.).
 * - If text is present, returns the joined text.
 * - If reasoning is present (Gemini 3 thinking output), returns the reasoning text.
 * - If not, returns a label for the first non-text modality (e.g., 'Image', 'Other').
 * - If unknown, returns 'Multimodal message'.
 *
 * Note: During streaming, each token may be sent as a separate text block.
 * Some streaming implementations send each token with a trailing newline,
 * which causes each word to render on a separate line.
 * We normalize this by:
 * 1. Joining tokens without extra spaces
 * 2. Replacing single newlines (not paragraph breaks) with spaces
 * 3. Preserving intentional paragraph breaks (double newlines)
 */
export function getContentString(content: Message["content"]): string {
  if (typeof content === "string" || !content) return content;
  const texts = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);
  // Join without space - streaming tokens already include proper spacing
  const joined = texts.join("");

  // Fix streaming newline issue:
  // 1. First, protect intentional paragraph breaks (double+ newlines) by replacing with placeholder
  // 2. Replace single newlines with spaces (these are likely streaming artifacts)
  // 3. Restore paragraph breaks
  return joined
    .replace(/\n\n+/g, "<<<PARAGRAPH_BREAK>>>")
    .replace(/\n/g, " ")
    .replace(/<<<PARAGRAPH_BREAK>>>/g, "\n\n")
    .replace(/  +/g, " "); // Clean up multiple spaces
}

/**
 * Type guard for reasoning content block (Gemini 3 thinking output)
 */
interface ReasoningContentBlock {
  type: "reasoning";
  reasoning: string;
}

function isReasoningBlock(block: unknown): block is ReasoningContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    (block as any).type === "reasoning" &&
    "reasoning" in block &&
    typeof (block as any).reasoning === "string"
  );
}

/**
 * Extracts reasoning/thinking text from a message's content.
 * This is specifically for Gemini 3 models that return thinking output
 * in content blocks with type: "reasoning".
 * 
 * @param content - The message content (string or array of content blocks)
 * @returns The reasoning text if present, undefined otherwise
 */
export function getReasoningString(content: Message["content"]): string | undefined {
  if (typeof content === "string" || !content) return undefined;
  
  // Filter and cast to ReasoningContentBlock[]
  const reasoningBlocks: ReasoningContentBlock[] = [];
  for (const block of content) {
    if (isReasoningBlock(block)) {
      reasoningBlocks.push(block);
    }
  }
  
  if (reasoningBlocks.length === 0) return undefined;
  
  // Join all reasoning blocks
  const reasoning = reasoningBlocks.map((b) => b.reasoning).join("\n\n");
  
  return reasoning || undefined;
}

/**
 * Extracts both text and reasoning from a message's content.
 * Returns reasoning if available, otherwise falls back to text content.
 * 
 * This is useful for displaying AI reasoning/thinking in the UI.
 * 
 * @param content - The message content (string or array of content blocks)
 * @returns Object with text and reasoning strings
 */
export function getContentWithReasoning(content: Message["content"]): {
  text: string;
  reasoning: string | undefined;
} {
  const text = getContentString(content);
  const reasoning = getReasoningString(content);
  
  return { text, reasoning };
}
