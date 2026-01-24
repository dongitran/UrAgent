/**
 * Logger Hub Client for logging AI model messages/responses
 * Logs are written to MongoDB via Logger Hub API
 * 
 * IMPORTANT: This client stores FULL payloads (no truncation) for debugging purposes.
 * 
 * Usage:
 *   import { logAIMessage } from "@openswe/shared/logger-hub-client";
 *   
 *   logAIMessage({
 *     threadId: "abc123",
 *     provider: "anthropic",
 *     modelName: "claude-opus-4-5",
 *     status: "success",
 *     requestMessages: [...],
 *     response: {...},
 *     durationMs: 1234,
 *     timestamp: Date.now(),
 *   });
 */

export type LogStatus = "success" | "error";

export interface AIMessageLog {
    /** The LangGraph thread ID for grouping related logs */
    threadId: string;
    /** The specific run ID within a thread */
    runId?: string;
    /** AI provider: anthropic, google-genai, openai */
    provider: string;
    /** Model name (e.g., claude-opus-4-5, gemini-3-pro-preview) */
    modelName: string;
    /** LLMTask: PLANNER, PROGRAMMER, REVIEWER, ROUTER, SUMMARIZER */
    task?: string;
    /** Status of the AI call: success or error */
    status: LogStatus;
    /** Current graph node name (e.g., generate-message, take-action, diagnose-error) */
    graphNode?: string;
    /** Current graph step number (0-based) */
    graphStep?: number;
    /** Full input messages */
    requestMessages: SerializedMessage[];
    /** Full response object (only present on success) */
    response?: SerializedResponse;
    /** Tool calls made by the model */
    responseToolCalls?: ToolCallSummary[];
    /** Time taken for the model call in milliseconds */
    durationMs: number;
    /** Token usage statistics */
    tokenUsage?: TokenUsage;
    /** Error details if call failed */
    error?: ErrorDetails;
    /** Unix timestamp of the log */
    timestamp: number;
    /** Retry attempt number (0-based) */
    retryAttempt?: number;
}

export interface ErrorDetails {
    /** Error message */
    message: string;
    /** Error name/type */
    name?: string;
    /** Error code if available */
    code?: string;
    /** HTTP status code if available */
    statusCode?: number;
    /** Full error object for debugging */
    raw?: unknown;
}

export interface SerializedMessage {
    /** Message role: human, ai, system, tool, etc. */
    role: string;
    /** Full message content - can be string or complex content array */
    content: unknown;
    /** Tool calls if present */
    toolCalls?: ToolCallSummary[];
    /** Additional kwargs from the message */
    additionalKwargs?: Record<string, unknown>;
    /** Response metadata if present (for AI messages) */
    responseMetadata?: Record<string, unknown>;
}

export interface SerializedResponse {
    /** Full response content - can be string or complex content array */
    content: unknown;
    /** Tool calls made by the model */
    toolCalls?: ToolCallSummary[];
    /** Whether response contains thinking content */
    hasThinkingContent?: boolean;
    /** Additional kwargs from the response */
    additionalKwargs?: Record<string, unknown>;
    /** Response metadata (contains token usage, model info, etc.) */
    responseMetadata?: Record<string, unknown>;
}

export interface ToolCallSummary {
    name: string;
    args?: Record<string, unknown>;
    id?: string;
}

export interface TokenUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

// Configuration from environment variables
const getLoggerHubUrl = () => process.env.LOGGER_HUB_URL || "";

const getLoggerHubApiKey = () => process.env.LOGGER_HUB_API_KEY || "";

const getLoggerHubCollection = () =>
    process.env.LOGGER_HUB_COLLECTION || "uragent-urtest-ai-messages";

const isLoggerHubEnabled = () => process.env.LOGGER_HUB_ENABLED !== "false" && !!getLoggerHubUrl();

/**
 * Log an AI message to Logger Hub
 * This is a fire-and-forget operation that doesn't block the main flow
 */
export async function logAIMessage(log: AIMessageLog): Promise<void> {
    if (!isLoggerHubEnabled()) return;

    try {
        // Fire and forget - don't block the main flow
        fetch(getLoggerHubUrl(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": getLoggerHubApiKey(),
            },
            body: JSON.stringify({
                collection: getLoggerHubCollection(),
                data: log,
            }),
        }).catch(() => {
            // Silently ignore errors to not affect main flow
        });
    } catch {
        // Silently ignore errors
    }
}

/**
 * Helper to create error details from an error object
 */
export function createErrorDetails(error: unknown): ErrorDetails {
    if (!error) {
        return { message: "Unknown error" };
    }

    if (error instanceof Error) {
        const details: ErrorDetails = {
            message: error.message,
            name: error.name,
        };

        // Try to extract additional error info
        const anyError = error as unknown as Record<string, unknown>;

        if (anyError.code !== undefined) {
            details.code = String(anyError.code);
        }
        if (anyError.status !== undefined) {
            details.statusCode = Number(anyError.status);
        }
        if (anyError.statusCode !== undefined) {
            details.statusCode = Number(anyError.statusCode);
        }

        // Store raw error for debugging (excluding stack to avoid huge logs)
        try {
            const rawError: Record<string, unknown> = {
                message: error.message,
                name: error.name,
            };
            if (anyError.code !== undefined) rawError.code = anyError.code;
            if (anyError.status !== undefined) rawError.status = anyError.status;
            if (anyError.statusCode !== undefined) rawError.statusCode = anyError.statusCode;
            if (anyError.type !== undefined) rawError.type = anyError.type;
            if (anyError.error !== undefined) rawError.error = anyError.error;
            if (anyError.cause !== undefined) rawError.cause = anyError.cause;
            details.raw = rawError;
        } catch {
            // Ignore serialization errors
        }

        return details;
    }

    if (typeof error === "object") {
        const anyError = error as Record<string, unknown>;
        return {
            message: String(anyError.message || anyError.error || JSON.stringify(error)),
            name: String(anyError.name || "Error"),
            code: anyError.code !== undefined ? String(anyError.code) : undefined,
            statusCode: anyError.status !== undefined ? Number(anyError.status) :
                anyError.statusCode !== undefined ? Number(anyError.statusCode) : undefined,
            raw: error,
        };
    }

    return {
        message: String(error),
    };
}

/**
 * Helper to extract token usage from AI response
 * Supports both Anthropic and Google Gemini response formats
 * 
 * Response formats handled:
 * 1. Anthropic: response_metadata.usage { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * 2. LangChain normalized (from Gemini): usage_metadata { input_tokens, output_tokens, total_tokens }
 * 3. Google raw (fallback): usage_metadata { promptTokenCount, responseTokenCount, totalTokenCount }
 */
export function extractTokenUsage(
    response: unknown
): AIMessageLog["tokenUsage"] | undefined {
    if (!response || typeof response !== "object") return undefined;

    const resp = response as Record<string, unknown>;

    // Try response_metadata (LangChain format for Anthropic)
    const metadata = resp.response_metadata as Record<string, unknown> | undefined;
    if (metadata) {
        // Anthropic format
        if (metadata.usage && typeof metadata.usage === "object") {
            const usage = metadata.usage as Record<string, unknown>;
            return {
                inputTokens: usage.input_tokens as number | undefined,
                outputTokens: usage.output_tokens as number | undefined,
                totalTokens:
                    ((usage.input_tokens as number) || 0) +
                    ((usage.output_tokens as number) || 0),
                cacheReadTokens: usage.cache_read_input_tokens as number | undefined,
                cacheCreationTokens: usage.cache_creation_input_tokens as
                    | number
                    | undefined,
            };
        }
    }

    // Try usage_metadata (Google Gemini format - normalized by LangChain)
    const usageMetadata = resp.usage_metadata as
        | Record<string, unknown>
        | undefined;
    if (usageMetadata) {
        // LangChain normalized format (from message-outputs.ts extractUsageMetadata)
        if (usageMetadata.input_tokens !== undefined || usageMetadata.output_tokens !== undefined) {
            return {
                inputTokens: usageMetadata.input_tokens as number | undefined,
                outputTokens: usageMetadata.output_tokens as number | undefined,
                totalTokens: usageMetadata.total_tokens as number | undefined,
            };
        }

        // Google raw format (fallback)
        if (usageMetadata.promptTokenCount !== undefined || usageMetadata.responseTokenCount !== undefined) {
            return {
                inputTokens: usageMetadata.promptTokenCount as number | undefined,
                outputTokens: usageMetadata.responseTokenCount as number | undefined,
                totalTokens: usageMetadata.totalTokenCount as number | undefined,
            };
        }
    }

    return undefined;
}

/**
 * Helper to extract tool calls from AI response
 */
export function extractToolCalls(
    response: unknown
): ToolCallSummary[] | undefined {
    if (!response || typeof response !== "object") return undefined;

    const resp = response as Record<string, unknown>;
    const toolCalls = resp.tool_calls as
        | Array<Record<string, unknown>>
        | undefined;

    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        return undefined;
    }

    return toolCalls.map((tc) => ({
        name: tc.name as string,
        args: tc.args as Record<string, unknown> | undefined,
        id: tc.id as string | undefined,
    }));
}

/**
 * Helper to serialize messages for logging - stores FULL content (no truncation)
 */
export function serializeMessages(
    messages: unknown[]
): SerializedMessage[] {
    if (!messages || !Array.isArray(messages)) return [];

    return messages.map((msg) => {
        if (!msg || typeof msg !== "object") {
            return { role: "unknown", content: String(msg) };
        }

        const m = msg as Record<string, unknown>;

        // Get role from LangChain message or plain object
        let role = "unknown";
        if (typeof m._getType === "function") {
            role = (m._getType as () => string)();
        } else if (typeof m.role === "string") {
            role = m.role;
        } else if (m.constructor?.name) {
            role = String(m.constructor.name).replace("Message", "").toLowerCase();
        }

        // Get full content (no truncation)
        const content = m.content;

        // Get tool calls if present
        const rawToolCalls = m.tool_calls as Array<Record<string, unknown>> | undefined;
        const toolCalls = rawToolCalls && Array.isArray(rawToolCalls) && rawToolCalls.length > 0
            ? rawToolCalls.map((tc) => ({
                name: tc.name as string,
                args: tc.args as Record<string, unknown> | undefined,
                id: tc.id as string | undefined,
            }))
            : undefined;

        // Get additional kwargs
        const additionalKwargs = m.additional_kwargs as Record<string, unknown> | undefined;

        // Get response metadata (for AI messages)
        const responseMetadata = m.response_metadata as Record<string, unknown> | undefined;

        return {
            role,
            content,
            ...(toolCalls && { toolCalls }),
            ...(additionalKwargs && Object.keys(additionalKwargs).length > 0 && { additionalKwargs }),
            ...(responseMetadata && { responseMetadata }),
        };
    });
}

/**
 * Helper to serialize response for logging - stores FULL content (no truncation)
 */
export function serializeResponse(response: unknown): SerializedResponse | undefined {
    if (!response || typeof response !== "object") return undefined;

    const resp = response as Record<string, unknown>;

    // Get full content (no truncation)
    const content = resp.content;

    // Check for thinking content if content is array
    let hasThinkingContent = false;
    if (Array.isArray(content)) {
        hasThinkingContent = content.some(
            (c: unknown) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "thinking"
        );
    }

    // Get tool calls
    const rawToolCalls = resp.tool_calls as Array<Record<string, unknown>> | undefined;
    const toolCalls = rawToolCalls && Array.isArray(rawToolCalls) && rawToolCalls.length > 0
        ? rawToolCalls.map((tc) => ({
            name: tc.name as string,
            args: tc.args as Record<string, unknown> | undefined,
            id: tc.id as string | undefined,
        }))
        : undefined;

    // Get additional kwargs
    const additionalKwargs = resp.additional_kwargs as Record<string, unknown> | undefined;

    // Get response metadata
    const responseMetadata = resp.response_metadata as Record<string, unknown> | undefined;

    return {
        content,
        ...(toolCalls && { toolCalls }),
        ...(hasThinkingContent && { hasThinkingContent }),
        ...(additionalKwargs && Object.keys(additionalKwargs).length > 0 && { additionalKwargs }),
        ...(responseMetadata && { responseMetadata }),
    };
}

// ============================================================================
// DEPRECATED: Keep old functions for backward compatibility, but they now call
// the new full-content versions
// ============================================================================

/** @deprecated Use serializeMessages instead */
export const summarizeMessages = serializeMessages;

/** @deprecated Use serializeResponse instead */
export const summarizeResponse = serializeResponse;

// Re-export types with old names for backward compatibility
export type RequestMessageSummary = SerializedMessage;
export type ResponseSummary = SerializedResponse;
