/**
 * Normalize tool call arguments to handle common AI model mistakes.
 * This must be called BEFORE tool.invoke() since LangChain validates
 * the schema before the handler runs.
 */

/**
 * Normalize grep tool arguments.
 * AI models sometimes use 'pattern' instead of 'query' and add invalid 'path' parameter.
 */
export function normalizeGrepToolArgs(args: Record<string, any>): Record<string, any> {
    const normalized = { ...args };

    // Map 'pattern' to 'query' if query is missing
    if ('pattern' in normalized && !('query' in normalized)) {
        normalized.query = normalized.pattern;
        delete normalized.pattern;
    }

    // Remove invalid 'path' parameter (doesn't exist in grep schema)
    if ('path' in normalized) {
        delete normalized.path;
    }

    return normalized;
}

/**
 * Normalize tool call arguments based on tool name.
 * Returns normalized args if tool has known normalization, otherwise returns original args.
 */
export function normalizeToolCallArgs(
    toolName: string,
    args: Record<string, any>
): Record<string, any> {
    switch (toolName) {
        case 'grep':
            return normalizeGrepToolArgs(args);
        default:
            return args;
    }
}
