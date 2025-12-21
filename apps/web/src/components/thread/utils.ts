import type { Message } from "@langchain/langgraph-sdk";

/**
 * Extracts a string summary from a message's content, supporting multimodal (text, image, file, etc.).
 * - If text is present, returns the joined text.
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
