import {
  BaseMessage,
  isAIMessage,
  isToolMessage,
} from "@langchain/core/messages";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "LoopDetection");

export interface ToolCallSignature {
  name: string;
  argsHash: string;
  fullArgs: Record<string, unknown>;
}

export interface ToolCallWithResult extends ToolCallSignature {
  status: "success" | "error" | "unknown";
  outputHash?: string; // Hash of tool output for comparison
}

export interface LoopDetectionResult {
  isLooping: boolean;
  loopCount: number;
  repeatedToolCall: ToolCallSignature | null;
  shouldForceCompletion: boolean;
  loopType: LoopType;
  recommendation: LoopRecommendation;
  /** Whether this is an edit loop (str_replace failing repeatedly) */
  isEditLoop: boolean;
  /** Whether outputs are varying (indicates potential progress) */
  hasVaryingOutputs: boolean;
  /** Number of times warning has been issued (for escalation) */
  warningCount: number;
}

export type LoopType =
  | "none"
  | "verification" // Agent keeps reading same file to verify
  | "error_retry" // Agent retrying same command that errors
  | "alternating" // A→B→A→B pattern
  | "read_only" // Agent only reading, not making progress
  | "similar_calls" // Same tool with slightly different args
  | "frequency" // Same tool called too frequently in window
  | "chanting" // Model generating same content repeatedly
  | "edit_loop" // Agent stuck trying to edit same file (str_replace failing)
  | "unknown";

export type LoopRecommendation =
  | "continue" // No action needed
  | "warn" // Inject warning into prompt
  | "force_complete" // Force mark task as completed
  | "request_help"; // Ask for human intervention

/**
 * Configuration for loop detection
 *
 * Thresholds are tuned based on research from:
 * - Claude Code Issue #4277: Tool Call Loops + Content Loops
 * - Gemini CLI Issue #11002: Output comparison for false positive reduction
 * - Gemini CLI Issue #5761: str_replace_based_edit_tool specific errors
 * - Cline Issue #2909: Diff Edit Mismatch errors (whitespace, line endings)
 * - Aider Issue #770: Edit format errors causing stuck loops
 * - Invariant Labs: Loop detection guardrails
 *
 * Edge cases considered:
 * - Build/test retry after fix (legitimate) - handled by hasVaryingOutputs
 * - Multi-file exploration (legitimate) - handled by uniqueFiles >= 5
 * - Parallel tool calls - handled by extractToolCallsByMessage
 * - Warning escalation - handled by MAX_WARNINGS_BEFORE_ESCALATE
 * - Request help then continue looping - handled by hasRecentHelpRequest (10 msg window)
 * - Rate limit retries (legitimate) - handled by checking error content
 * - Partial success loops - handled by tracking success/error ratio
 */
export const LOOP_DETECTION_CONFIG = {
  /** Number of consecutive identical tool calls to consider as a loop (warn) */
  LOOP_THRESHOLD: 20, // 5 * 4 = 20
  /** Number of consecutive identical tool calls to force task completion */
  FORCE_COMPLETION_THRESHOLD: 32, // 8 * 4 = 32
  /** Number of recent messages to analyze for loop detection */
  MESSAGES_TO_ANALYZE: 120, // 30 * 4 = 120
  /** Threshold for read-only loop detection (% of read operations) */
  READ_ONLY_THRESHOLD: 0.85, // Keep percentage threshold unchanged
  /** Minimum tool calls to analyze for patterns */
  MIN_CALLS_FOR_PATTERN: 24, // 6 * 4 = 24
  /** Threshold for similar tool detection (same tool, different args) */
  SIMILAR_TOOL_THRESHOLD: 24, // 6 * 4 = 24
  /** Window size for frequency-based detection */
  FREQUENCY_WINDOW: 80, // 20 * 4 = 80
  /** Frequency threshold (same tool called X times in window) */
  FREQUENCY_THRESHOLD: 48, // 12 * 4 = 48
  /** Edit loop threshold - more severe, request help earlier */
  EDIT_LOOP_THRESHOLD: 20, // 5 * 4 = 20
  /** Maximum warnings before escalating to force_complete */
  MAX_WARNINGS_BEFORE_ESCALATE: 12, // 3 * 4 = 12
  /** Minimum unique files to consider as legitimate exploration (not a loop) */
  MIN_UNIQUE_FILES_FOR_EXPLORATION: 32, // 8 * 4 = 32
  /** Similarity threshold for chanting detection (Jaccard similarity) */
  CHANTING_SIMILARITY_THRESHOLD: 0.9, // Keep percentage threshold unchanged
  /** Minimum consecutive chanting messages to trigger detection */
  CHANTING_MIN_COUNT: 12, // 3 * 4 = 12
  /** Error rate threshold for error retry loop detection (60%) */
  ERROR_RATE_THRESHOLD: 0.6, // Keep percentage threshold unchanged
  /** Minimum tool calls to check for error rate */
  MIN_CALLS_FOR_ERROR_RATE: 20, // 5 * 4 = 20
  /** Minimum unique shell commands to consider as legitimate work (not a loop) */
  MIN_UNIQUE_SHELL_COMMANDS: 16, // 4 * 4 = 16
};

/** Tools that are considered "read-only" operations */
const READ_ONLY_TOOLS = [
  "view", // View tool for reading files
  "shell", // When used with cat, ls, grep, etc.
  "grep",
  "search",
  "get_url_content",
  "search_document_for",
];

/** Shell commands that are read-only */
const READ_ONLY_SHELL_COMMANDS = [
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "find",
  "tree",
  "pwd",
  "echo",
  "wc",
];

/** Tools that indicate actual progress (write operations) */
const WRITE_TOOLS = [
  "str_replace_based_edit_tool",
  "apply_patch",
  "install_dependencies",
];

/** Shell commands that indicate actual progress */
const WRITE_SHELL_COMMANDS = [
  "npm",
  "yarn",
  "pnpm",
  "mkdir",
  "touch",
  "rm",
  "mv",
  "cp",
  "git",
];

/**
 * Creates a hash of tool call arguments for comparison
 */
function hashToolCallArgs(
  args: Record<string, unknown> | null | undefined,
): string {
  if (!args || typeof args !== "object") {
    return "{}";
  }

  try {
    const sortedArgs = Object.keys(args)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = args[key];
          return acc;
        },
        {} as Record<string, unknown>,
      );
    return JSON.stringify(sortedArgs);
  } catch {
    return JSON.stringify(args);
  }
}

/**
 * Checks if a tool call is a read-only operation
 */
function isReadOnlyToolCall(
  name: string,
  args: Record<string, unknown>,
): boolean {
  // view tool is always read-only
  if (name === "view") {
    return true;
  }

  if (READ_ONLY_TOOLS.includes(name) && name !== "shell") {
    return true;
  }

  if (name === "shell" && typeof args.command === "string") {
    const baseCommand = args.command.trim().split(" ")[0];
    return READ_ONLY_SHELL_COMMANDS.includes(baseCommand);
  }

  return false;
}

/**
 * Checks if a tool call is a write operation (indicates progress)
 */
function isWriteToolCall(name: string, args: Record<string, unknown>): boolean {
  if (WRITE_TOOLS.includes(name)) {
    return true;
  }

  if (name === "shell" && typeof args.command === "string") {
    const baseCommand = args.command.trim().split(" ")[0];
    return WRITE_SHELL_COMMANDS.includes(baseCommand);
  }

  return false;
}

/**
 * Normalizes a file path for comparison
 */
function normalizeFilePath(path: string): string {
  // Remove leading ./
  let normalized = path.replace(/^\.\//, "");
  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

/**
 * Extracts target file from tool call args (for similarity detection)
 * Improved regex to handle more patterns
 */
function extractTargetFile(
  name: string,
  args: Record<string, unknown>,
): string | null {
  let targetFile: string | null = null;

  // Shell commands with file targets
  if (name === "shell" && typeof args.command === "string") {
    const command = args.command.trim();

    // Pattern 1: cat/head/tail with optional flags: "cat -n file.ts", "head -50 file.ts"
    const catMatch = command.match(
      /^(?:cat|head|tail|less|more)\s+(?:-[^\s]+\s+)*([^\s|>]+)/,
    );
    if (catMatch && catMatch[1] && !catMatch[1].startsWith("-")) {
      targetFile = catMatch[1];
    }

    // Pattern 2: grep with file: "grep pattern file.ts", "grep -r pattern dir"
    if (!targetFile) {
      const grepMatch = command.match(
        /grep\s+(?:-[^\s]+\s+)*(?:"[^"]*"|'[^']*'|\S+)\s+([^\s|>]+)/,
      );
      if (grepMatch && grepMatch[1]) {
        targetFile = grepMatch[1];
      }
    }

    // Pattern 3: Simple file read at end of command
    if (!targetFile) {
      const simpleMatch = command.match(
        /\s([^\s|>]+\.[a-zA-Z0-9]+)(?:\s*$|\s*\|)/,
      );
      if (simpleMatch && simpleMatch[1]) {
        targetFile = simpleMatch[1];
      }
    }
  }

  // view tool - extracts path from args.path
  if (name === "view" && typeof args.path === "string") {
    targetFile = args.path;
  }

  // str_replace_based_edit_tool
  if (name === "str_replace_based_edit_tool" && typeof args.path === "string") {
    targetFile = args.path;
  }

  // apply_patch tool
  if (name === "apply_patch" && typeof args.patch === "string") {
    // Extract file path from patch content (e.g., "--- a/src/file.ts" or "+++ b/src/file.ts")
    const patchMatch = args.patch.match(/^(?:---|\+\+\+)\s+[ab]\/(.+)$/m);
    if (patchMatch && patchMatch[1]) {
      targetFile = patchMatch[1];
    }
  }

  // apply_patch tool - also check file_path arg
  if (name === "apply_patch" && typeof args.file_path === "string") {
    targetFile = args.file_path;
  }

  // grep tool
  if (name === "grep" && typeof args.path === "string") {
    targetFile = args.path;
  }

  // search_document_for tool
  if (name === "search_document_for" && typeof args.file_path === "string") {
    targetFile = args.file_path;
  }

  // Normalize the path if found
  return targetFile ? normalizeFilePath(targetFile) : null;
}

/**
 * Extracts tool call signatures from recent messages with their results
 * Note: Each AIMessage can have multiple tool calls (parallel calls)
 * We track them separately but also track which ones are from the same message
 */
function extractRecentToolCalls(messages: BaseMessage[]): ToolCallSignature[] {
  const toolCalls: ToolCallSignature[] = [];
  const recentMessages = messages.slice(
    -LOOP_DETECTION_CONFIG.MESSAGES_TO_ANALYZE,
  );

  for (const message of recentMessages) {
    if (isAIMessage(message) && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        const args = (toolCall.args as Record<string, unknown>) || {};
        toolCalls.push({
          name: toolCall.name || "unknown",
          argsHash: hashToolCallArgs(args),
          fullArgs: args,
        });
      }
    }
  }

  return toolCalls;
}

/**
 * Extracts tool calls grouped by message (for detecting parallel vs sequential calls)
 */
function extractToolCallsByMessage(
  messages: BaseMessage[],
): ToolCallSignature[][] {
  const toolCallsByMessage: ToolCallSignature[][] = [];
  const recentMessages = messages.slice(
    -LOOP_DETECTION_CONFIG.MESSAGES_TO_ANALYZE,
  );

  for (const message of recentMessages) {
    if (isAIMessage(message) && message.tool_calls?.length) {
      const messageCalls: ToolCallSignature[] = [];
      for (const toolCall of message.tool_calls) {
        const args = (toolCall.args as Record<string, unknown>) || {};
        messageCalls.push({
          name: toolCall.name || "unknown",
          argsHash: hashToolCallArgs(args),
          fullArgs: args,
        });
      }
      if (messageCalls.length > 0) {
        toolCallsByMessage.push(messageCalls);
      }
    }
  }

  return toolCallsByMessage;
}

/**
 * Extracts tool calls with their results (success/error)
 * Improved: Also check content for error patterns and track output hash
 * Added: Specific detection for str_replace errors
 */
function extractToolCallsWithResults(
  messages: BaseMessage[],
): ToolCallWithResult[] {
  const toolCallsWithResults: ToolCallWithResult[] = [];
  const recentMessages = messages.slice(
    -LOOP_DETECTION_CONFIG.MESSAGES_TO_ANALYZE,
  );

  // Build a map of tool_call_id to status, content, and output hash
  const statusMap = new Map<
    string,
    {
      status: "success" | "error" | "unknown";
      content?: string;
      outputHash?: string;
      toolName?: string;
    }
  >();

  // First pass: collect tool names from AIMessages
  const toolNameMap = new Map<string, string>();
  for (const message of recentMessages) {
    if (isAIMessage(message) && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id) {
          toolNameMap.set(toolCall.id, toolCall.name || "unknown");
        }
      }
    }
  }

  // Second pass: collect results from ToolMessages
  for (const message of recentMessages) {
    if (isToolMessage(message) && message.tool_call_id) {
      const content =
        typeof message.content === "string" ? message.content : "";
      const toolName = toolNameMap.get(message.tool_call_id) || "unknown";

      // Check for error patterns in content even if status is success
      // Special handling for str_replace errors
      // Exclude rate limit errors from being counted as errors (they are legitimate retries)
      const hasErrorInContent = checkContentForErrors(content);
      const hasStrReplaceError = isStrReplaceError(toolName, content);
      const isRateLimit = isRateLimitError(content);

      // Rate limit errors should be treated as "unknown" (not error) to avoid false positive loop detection
      let effectiveStatus: "success" | "error" | "unknown" = "success";
      if (isRateLimit) {
        effectiveStatus = "unknown"; // Don't count rate limits as errors
      } else if (
        message.status === "error" ||
        hasErrorInContent ||
        hasStrReplaceError
      ) {
        effectiveStatus = "error";
      }

      // Create a simple hash of output for comparison
      const outputHash = content ? simpleHash(content) : undefined;
      statusMap.set(message.tool_call_id, {
        status: effectiveStatus,
        content,
        outputHash,
        toolName,
      });
    }
  }

  // Extract tool calls with their status
  for (const message of recentMessages) {
    if (isAIMessage(message) && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        const args = (toolCall.args as Record<string, unknown>) || {};
        const statusInfo = toolCall.id ? statusMap.get(toolCall.id) : undefined;
        const status = statusInfo?.status || "unknown";
        toolCallsWithResults.push({
          name: toolCall.name || "unknown",
          argsHash: hashToolCallArgs(args),
          fullArgs: args,
          status,
          outputHash: statusInfo?.outputHash,
        });
      }
    }
  }

  return toolCallsWithResults;
}

/**
 * Simple hash function for output comparison
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Checks if tool output content contains error patterns
 * Improved: More specific patterns to avoid false positives
 * Added: str_replace_based_edit_tool specific errors
 */
function checkContentForErrors(content: string): boolean {
  if (!content) return false;

  const lowerContent = content.toLowerCase();

  // Patterns that strongly indicate errors
  const strongErrorPatterns = [
    "error:",
    "failed:",
    "exception:",
    "traceback (most recent call last)",
    "command failed with exit code",
    "permission denied",
    "syntax error",
    "syntaxerror:",
    "typeerror:",
    "referenceerror:",
    "nameerror:",
    "valueerror:",
    "keyerror:",
    "attributeerror:",
    "importerror:",
    "modulenotfounderror:",
    "indentationerror:",
    "compilation error",
    "build failed",
    "npm err!",
    "yarn error",
    "fatal:",
    "panic:",
    "segmentation fault",
    "cannot read properties of",
    "is not defined",
    "module not found",
    "enoent:",
    "eacces:",
    "eperm:",
    "eexist:",
    "cannot find module",
    "unexpected token",
    "unterminated string",
    // str_replace_based_edit_tool specific errors (from Gemini CLI issue)
    "0 occurrences found",
    "no occurrences found",
    "old_string not found",
    "exact text in old_string was not found",
    "failed to edit",
    "invalid tool call",
  ];

  // Check strong error patterns
  for (const pattern of strongErrorPatterns) {
    if (lowerContent.includes(pattern)) {
      return true;
    }
  }

  // Patterns that need context (avoid false positives)
  // "not found" alone is too generic - need more context
  if (lowerContent.includes("no such file or directory")) {
    return true;
  }

  // Check for exit code patterns (non-zero exit)
  if (/exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*/i.test(content)) {
    return true;
  }

  // Check for stack traces (multiple "at " lines)
  const atLines = (content.match(/^\s+at\s+/gm) || []).length;
  if (atLines >= 3) {
    return true;
  }

  return false;
}

/**
 * Checks if error is a rate limit error (should not be counted as loop)
 * Rate limit retries are legitimate and should not trigger loop detection
 */
function isRateLimitError(content: string): boolean {
  if (!content) return false;

  const lowerContent = content.toLowerCase();
  const rateLimitPatterns = [
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "429",
    "quota exceeded",
    "throttled",
    "retry after",
    "retry-after",
    "slow down",
    "request limit",
    "api limit",
  ];

  for (const pattern of rateLimitPatterns) {
    if (lowerContent.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a tool call is a str_replace edit that failed
 * This is specifically for detecting edit loops from Gemini CLI Issue #5761
 *
 * Common causes of str_replace failures:
 * - Whitespace mismatch (spaces vs tabs, trailing spaces)
 * - Line ending differences (LF vs CRLF)
 * - BOM (Byte Order Mark) in file
 * - Incorrect indentation
 * - File content changed between read and edit
 */
function isStrReplaceError(toolName: string, content: string): boolean {
  if (toolName !== "str_replace_based_edit_tool") {
    return false;
  }

  const lowerContent = content.toLowerCase();
  const strReplaceErrorPatterns = [
    "0 occurrences found",
    "no occurrences found",
    "old_string not found",
    "exact text in old_string was not found",
    "failed to edit",
    "the search block failed to match",
    "search/replace block failed",
    "did not match any lines",
    "no match found",
    "could not find",
    "string not found in file",
    // Additional patterns from Cline Issue #2909
    "diff edit mismatch",
    "search block content doesn't match",
    "file was reverted",
  ];

  for (const pattern of strReplaceErrorPatterns) {
    if (lowerContent.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if agent has recently requested human help
 */
function hasRecentHelpRequest(messages: BaseMessage[]): boolean {
  const recentMessages = messages.slice(-10);

  for (const message of recentMessages) {
    if (isAIMessage(message) && message.tool_calls?.length) {
      if (message.tool_calls.some((tc) => tc.name === "request_human_help")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detects "chanting" - when model generates the same content repeatedly
 * This is inspired by Claude Code and Gemini CLI loop detection
 */
function detectChanting(messages: BaseMessage[]): {
  isChanting: boolean;
  repeatedContent: string | null;
  count: number;
} {
  const recentMessages = messages.slice(-10);
  const aiContents: string[] = [];

  for (const message of recentMessages) {
    if (isAIMessage(message)) {
      const content =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((c) => (typeof c === "string" ? c : (c as any).text || ""))
                .join(" ")
            : "";

      if (content.trim()) {
        aiContents.push(content.trim());
      }
    }
  }

  if (aiContents.length < 3) {
    return { isChanting: false, repeatedContent: null, count: 0 };
  }

  // Check for consecutive identical content
  const lastContent = aiContents[aiContents.length - 1];
  let count = 1;

  for (let i = aiContents.length - 2; i >= 0; i--) {
    // Use similarity check instead of exact match (content might have minor variations)
    if (
      aiContents[i] === lastContent ||
      (aiContents[i].length > 50 &&
        lastContent.length > 50 &&
        calculateSimilarity(aiContents[i], lastContent) >
          LOOP_DETECTION_CONFIG.CHANTING_SIMILARITY_THRESHOLD)
    ) {
      count++;
    } else {
      break;
    }
  }

  // Consider chanting if same content appears 3+ times
  return {
    isChanting: count >= LOOP_DETECTION_CONFIG.CHANTING_MIN_COUNT,
    repeatedContent:
      count >= LOOP_DETECTION_CONFIG.CHANTING_MIN_COUNT
        ? lastContent.substring(0, 100)
        : null,
    count,
  };
}

/**
 * Simple similarity calculation (Jaccard-like)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/));
  const words2 = new Set(str2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Counts consecutive identical tool calls from the end
 * Improved: Handle parallel tool calls correctly and check output comparison
 * - If a message has multiple parallel calls, they count as 1 "round"
 * - We look for consecutive messages with the same single tool call
 * - If outputs are different, it's not a stuck loop (agent is making progress)
 *
 * Fixed: Use index-based tracking for output hashes to correctly match calls
 *
 * Enhanced: Also detect parallel call loops (same parallel calls repeated)
 */
function countConsecutiveIdenticalCalls(
  toolCalls: ToolCallSignature[],
  messages?: BaseMessage[],
): {
  count: number;
  signature: ToolCallSignature | null;
  hasVaryingOutputs: boolean;
} {
  if (toolCalls.length === 0) {
    return { count: 0, signature: null, hasVaryingOutputs: false };
  }

  // If we have messages, use message-based counting (more accurate)
  if (messages) {
    const toolCallsByMessage = extractToolCallsByMessage(messages);
    const toolCallsWithResults = extractToolCallsWithResults(messages);

    if (toolCallsByMessage.length === 0) {
      return { count: 0, signature: null, hasVaryingOutputs: false };
    }

    const lastMessageCalls = toolCallsByMessage[toolCallsByMessage.length - 1];

    // Enhanced: Check for parallel call loops (same set of parallel calls repeated)
    if (lastMessageCalls.length > 1) {
      // Create a signature for the entire parallel call set
      const lastParallelSignature = lastMessageCalls
        .map((tc) => `${tc.name}:${tc.argsHash}`)
        .sort()
        .join("|");

      let parallelCount = 1;
      for (let i = toolCallsByMessage.length - 2; i >= 0; i--) {
        const messageCalls = toolCallsByMessage[i];
        if (messageCalls.length === lastMessageCalls.length) {
          const parallelSignature = messageCalls
            .map((tc) => `${tc.name}:${tc.argsHash}`)
            .sort()
            .join("|");
          if (parallelSignature === lastParallelSignature) {
            parallelCount++;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      // If parallel calls are repeating, it's still a loop
      if (parallelCount >= 3) {
        logger.warn("Detected parallel call loop", {
          parallelCount,
          callCount: lastMessageCalls.length,
          tools: lastMessageCalls.map((tc) => tc.name),
        });
        return {
          count: parallelCount,
          signature: lastMessageCalls[0],
          hasVaryingOutputs: false,
        };
      }

      return {
        count: 1,
        signature: lastMessageCalls[0],
        hasVaryingOutputs: false,
      };
    }

    const lastCall = lastMessageCalls[0];
    let count = 1;
    const outputHashes = new Set<string>();

    // Build a map of message index to output hashes for accurate tracking
    // This fixes the bug where find() always returns the first matching call
    const messageOutputHashes: (string | undefined)[] = [];
    let toolCallIndex = 0;

    for (const messageCalls of toolCallsByMessage) {
      if (
        messageCalls.length === 1 &&
        messageCalls[0].name === lastCall.name &&
        messageCalls[0].argsHash === lastCall.argsHash
      ) {
        // Find the corresponding result by index
        const result = toolCallsWithResults[toolCallIndex];
        messageOutputHashes.push(result?.outputHash);
      } else {
        messageOutputHashes.push(undefined);
      }
      toolCallIndex += messageCalls.length;
    }

    // Get output hash for the last matching call
    const lastOutputHash = messageOutputHashes[messageOutputHashes.length - 1];
    if (lastOutputHash) {
      outputHashes.add(lastOutputHash);
    }

    // Count consecutive messages with the same single tool call
    for (let i = toolCallsByMessage.length - 2; i >= 0; i--) {
      const messageCalls = toolCallsByMessage[i];
      // Only count if message has exactly 1 tool call that matches
      if (
        messageCalls.length === 1 &&
        messageCalls[0].name === lastCall.name &&
        messageCalls[0].argsHash === lastCall.argsHash
      ) {
        count++;

        // Track output hash for this call using the pre-computed map
        const outputHash = messageOutputHashes[i];
        if (outputHash) {
          outputHashes.add(outputHash);
        }
      } else {
        break;
      }
    }

    // If outputs are varying (different hashes), agent might be making progress
    // This helps avoid false positives for legitimate retry scenarios
    const hasVaryingOutputs = outputHashes.size > 1;

    return { count, signature: lastCall, hasVaryingOutputs };
  }

  // Fallback to simple counting (for backward compatibility)
  const lastCall = toolCalls[toolCalls.length - 1];
  let count = 1;

  for (let i = toolCalls.length - 2; i >= 0; i--) {
    const call = toolCalls[i];
    if (call.name === lastCall.name && call.argsHash === lastCall.argsHash) {
      count++;
    } else {
      break;
    }
  }

  return { count, signature: lastCall, hasVaryingOutputs: false };
}

/**
 * Detects alternating pattern (A→B→A→B) and 3-element cycles (A→B→C→A→B→C)
 * Improved: Check 6-element first (more severe), then 4-element, also check 3-element cycles
 * Also detects "oscillating file edits" - editing same files repeatedly with different content
 */
function detectAlternatingPattern(toolCalls: ToolCallSignature[]): {
  isAlternating: boolean;
  patternLength: number;
  cycleType: "2-element" | "3-element" | "oscillating" | "none";
} {
  if (toolCalls.length < 4) {
    return { isAlternating: false, patternLength: 0, cycleType: "none" };
  }

  // Check for 6-element 3-cycle pattern first (A→B→C→A→B→C) - most severe
  if (toolCalls.length >= 6) {
    const last6 = toolCalls.slice(-6);
    const sig0 = `${last6[0].name}:${last6[0].argsHash}`;
    const sig1 = `${last6[1].name}:${last6[1].argsHash}`;
    const sig2 = `${last6[2].name}:${last6[2].argsHash}`;
    const sig3 = `${last6[3].name}:${last6[3].argsHash}`;
    const sig4 = `${last6[4].name}:${last6[4].argsHash}`;
    const sig5 = `${last6[5].name}:${last6[5].argsHash}`;

    // Check 2-element alternating: A→B→A→B→A→B
    if (
      sig0 === sig2 &&
      sig2 === sig4 &&
      sig1 === sig3 &&
      sig3 === sig5 &&
      sig0 !== sig1
    ) {
      return { isAlternating: true, patternLength: 6, cycleType: "2-element" };
    }

    // Check 3-element cycle: A→B→C→A→B→C
    if (
      sig0 === sig3 &&
      sig1 === sig4 &&
      sig2 === sig5 &&
      sig0 !== sig1 &&
      sig1 !== sig2 &&
      sig0 !== sig2
    ) {
      return { isAlternating: true, patternLength: 6, cycleType: "3-element" };
    }

    // Check for oscillating file edits: same tool on same files but different args
    // Pattern: edit(fileA, v1) → edit(fileB, v1) → edit(fileA, v2) → edit(fileB, v2) → ...
    const files = last6.map((tc) => extractTargetFile(tc.name, tc.fullArgs));
    const isAllEdits = last6.every(
      (tc) =>
        tc.name === "str_replace_based_edit_tool" || tc.name === "apply_patch",
    );

    if (isAllEdits && files[0] && files[1]) {
      // Check if alternating between 2 files
      const file0 = files[0];
      const file1 = files[1];
      if (
        file0 !== file1 &&
        files[2] === file0 &&
        files[3] === file1 &&
        files[4] === file0 &&
        files[5] === file1
      ) {
        // Oscillating between 2 files - this is suspicious
        return {
          isAlternating: true,
          patternLength: 6,
          cycleType: "oscillating",
        };
      }
    }
  }

  // Check for 4-element alternating pattern (A→B→A→B)
  const last4 = toolCalls.slice(-4);
  if (last4.length >= 4) {
    const sig0 = `${last4[0].name}:${last4[0].argsHash}`;
    const sig1 = `${last4[1].name}:${last4[1].argsHash}`;
    const sig2 = `${last4[2].name}:${last4[2].argsHash}`;
    const sig3 = `${last4[3].name}:${last4[3].argsHash}`;

    if (sig0 === sig2 && sig1 === sig3 && sig0 !== sig1) {
      return { isAlternating: true, patternLength: 4, cycleType: "2-element" };
    }

    // Check for 4-element oscillating file edits
    const files = last4.map((tc) => extractTargetFile(tc.name, tc.fullArgs));
    const isAllEdits = last4.every(
      (tc) =>
        tc.name === "str_replace_based_edit_tool" || tc.name === "apply_patch",
    );

    if (isAllEdits && files[0] && files[1] && files[0] !== files[1]) {
      if (files[2] === files[0] && files[3] === files[1]) {
        return {
          isAlternating: true,
          patternLength: 4,
          cycleType: "oscillating",
        };
      }
    }
  }

  return { isAlternating: false, patternLength: 0, cycleType: "none" };
}

/**
 * Detects read-only loop (agent only reading, not making progress)
 * 
 * IMPORTANT LOGIC:
 * - View 5 different files = NOT a loop (exploration)
 * - View same file 9 times consecutively = IS a loop
 * - If there are write operations, agent is making progress
 * 
 * This function checks for:
 * 1. Agent ONLY doing read operations (no writes at all) for extended period
 * 2. Reading the SAME file consecutively many times
 */
function detectReadOnlyLoop(toolCalls: ToolCallSignature[]): boolean {
  if (toolCalls.length < LOOP_DETECTION_CONFIG.MIN_CALLS_FOR_PATTERN) {
    return false;
  }

  const recentCalls = toolCalls.slice(-10);
  const readOnlyCount = recentCalls.filter((tc) =>
    isReadOnlyToolCall(tc.name, tc.fullArgs),
  ).length;

  // Check if there are any write operations - if so, agent is making progress
  const hasWriteOps = recentCalls.some((tc) =>
    isWriteToolCall(tc.name, tc.fullArgs),
  );

  if (hasWriteOps) {
    return false; // Agent is making progress with writes
  }

  // Check if agent is exploring many different files (legitimate exploration)
  const uniqueFiles = new Set<string>();

  for (const tc of recentCalls) {
    const target = extractTargetFile(tc.name, tc.fullArgs);
    if (target) {
      uniqueFiles.add(target);
    }
  }

  // If reading 5+ unique files, it's legitimate exploration, not a loop
  if (uniqueFiles.size >= 5) {
    return false;
  }

  // Only trigger read-only loop if 85%+ of recent calls are read-only
  // AND there are no write operations at all
  // AND reading only 1-2 unique files (stuck on same files)
  return (
    readOnlyCount / recentCalls.length >= LOOP_DETECTION_CONFIG.READ_ONLY_THRESHOLD &&
    uniqueFiles.size <= 2
  );
}

/**
 * Detects "tool switching loop" - agent alternates between different tools for same purpose
 * Pattern: str_replace fail → apply_patch fail → str_replace fail → apply_patch fail
 * This is a more sophisticated loop where agent tries different tools but same goal
 */
function detectToolSwitchingLoop(
  toolCalls: ToolCallSignature[],
  messages: BaseMessage[],
): {
  isToolSwitching: boolean;
  targetFile: string | null;
  switchCount: number;
} {
  if (toolCalls.length < 4) {
    return { isToolSwitching: false, targetFile: null, switchCount: 0 };
  }

  const toolCallsWithResults = extractToolCallsWithResults(messages);
  const recentCalls = toolCalls.slice(-10);

  // Track edit attempts per file with different tools
  const fileEditAttempts = new Map<
    string,
    { tools: Set<string>; failCount: number }
  >();

  for (let i = 0; i < recentCalls.length; i++) {
    const tc = recentCalls[i];
    const targetFile = extractTargetFile(tc.name, tc.fullArgs);

    if (!targetFile) continue;

    // Only track edit tools
    if (
      tc.name !== "str_replace_based_edit_tool" &&
      tc.name !== "apply_patch"
    ) {
      continue;
    }

    if (!fileEditAttempts.has(targetFile)) {
      fileEditAttempts.set(targetFile, { tools: new Set(), failCount: 0 });
    }

    const attempts = fileEditAttempts.get(targetFile)!;
    attempts.tools.add(tc.name);

    // Check if this call failed
    const result = toolCallsWithResults[i];
    if (result?.status === "error") {
      attempts.failCount++;
    }
  }

  // Find file with tool switching pattern (multiple tools, multiple failures)
  for (const [file, attempts] of fileEditAttempts) {
    if (attempts.tools.size >= 2 && attempts.failCount >= 3) {
      return {
        isToolSwitching: true,
        targetFile: file,
        switchCount: attempts.failCount,
      };
    }
  }

  return { isToolSwitching: false, targetFile: null, switchCount: 0 };
}

/**
 * Detects "delayed loop" - same action repeated but not consecutively
 * Pattern: A→B→C→A→D→E→A→F→G→A (A repeats but with other actions in between)
 * This catches loops that are spread out over time
 */
/**
 * Detects "delayed loop" - same action repeated but not consecutively
 * Pattern: A→B→C→A→D→E→A→F→G→A (A repeats but with other actions in between)
 * 
 * IMPORTANT: This should only trigger for IDENTICAL tool calls (same name + same args)
 * If agent calls yarn build, then view file, then yarn build again - that's NOT a loop
 * because the view operation in between means agent is trying something different.
 * 
 * Only trigger if the SAME EXACT call (same tool + same args) appears many times
 * AND there are no significant different operations in between.
 */
function detectDelayedLoop(toolCalls: ToolCallSignature[]): {
  isDelayedLoop: boolean;
  repeatedSignature: ToolCallSignature | null;
  occurrences: number;
} {
  if (toolCalls.length < 8) {
    return { isDelayedLoop: false, repeatedSignature: null, occurrences: 0 };
  }

  const recentCalls = toolCalls.slice(-20);

  // Count occurrences of each unique tool call
  const signatureCounts = new Map<
    string,
    { count: number; signature: ToolCallSignature }
  >();

  for (const tc of recentCalls) {
    const key = `${tc.name}:${tc.argsHash}`;
    if (!signatureCounts.has(key)) {
      signatureCounts.set(key, { count: 0, signature: tc });
    }
    signatureCounts.get(key)!.count++;
  }

  // Find the most repeated call
  let maxCount = 0;
  let maxSignature: ToolCallSignature | null = null;

  for (const [, data] of signatureCounts) {
    if (data.count > maxCount) {
      maxCount = data.count;
      maxSignature = data.signature;
    }
  }

  // Only trigger delayed loop if:
  // 1. Same EXACT call (same tool + same args) appears 7+ times (high threshold)
  // 2. It's a write operation (edit/shell command) - read operations are normal
  // 3. The call is NOT a build/test command (those are expected to be retried)
  if (maxCount >= 7 && maxSignature) {
    const isReadOp = isReadOnlyToolCall(maxSignature.name, maxSignature.fullArgs);
    
    // Don't trigger for read operations - reading same file multiple times is normal
    if (isReadOp) {
      return { isDelayedLoop: false, repeatedSignature: null, occurrences: 0 };
    }
    
    // Don't trigger for build/test commands - they are expected to be retried after fixes
    if (maxSignature.name === "shell" && typeof maxSignature.fullArgs.command === "string") {
      const cmd = maxSignature.fullArgs.command.trim();
      if (/^(npm|yarn|pnpm)\s+(run\s+)?(build|test|lint|check|compile|tsc)/.test(cmd)) {
        return { isDelayedLoop: false, repeatedSignature: null, occurrences: 0 };
      }
    }
    
    // Only trigger for write operations that are NOT build/test
    if (isWriteToolCall(maxSignature.name, maxSignature.fullArgs)) {
      return {
        isDelayedLoop: true,
        repeatedSignature: maxSignature,
        occurrences: maxCount,
      };
    }
  }

  return { isDelayedLoop: false, repeatedSignature: null, occurrences: 0 };
}

/**
 * Detects similar tool calls (same tool, different args but same target)
 * 
 * IMPORTANT LOGIC:
 * - Loop = calling the SAME file CONSECUTIVELY multiple times
 * - ANY different command/file should RESET the count
 * - View fileA → view fileB → view fileA = count resets at fileB, so fileA count = 1
 * - View fileA → yarn build → view fileA = count resets at yarn build, so fileA count = 1
 * - View fileA 9 times consecutively = IS a loop (count = 9)
 */
function detectSimilarToolCalls(toolCalls: ToolCallSignature[]): {
  isSimilar: boolean;
  count: number;
  targetFile: string | null;
  isEditLoop: boolean;
  editCount: number;
} {
  if (toolCalls.length < LOOP_DETECTION_CONFIG.SIMILAR_TOOL_THRESHOLD) {
    return {
      isSimilar: false,
      count: 0,
      targetFile: null,
      isEditLoop: false,
      editCount: 0,
    };
  }

  const recentCalls = toolCalls.slice(-LOOP_DETECTION_CONFIG.FREQUENCY_WINDOW);

  // Count CONSECUTIVE accesses to the same file (from the end)
  // RESET when ANY different operation is performed (different file OR different command)
  let consecutiveFileCount = 0;
  let currentFile: string | null = null;
  let consecutiveEditCount = 0;
  let editFile: string | null = null;
  let isFirstIteration = true;

  // Scan from the end to find consecutive same-file accesses
  for (let i = recentCalls.length - 1; i >= 0; i--) {
    const tc = recentCalls[i];
    const targetFile = extractTargetFile(tc.name, tc.fullArgs);

    // First iteration - initialize with the last call
    if (isFirstIteration) {
      isFirstIteration = false;
      
      if (targetFile) {
        // Last call has a target file - start counting
        currentFile = targetFile;
        consecutiveFileCount = 1;
        
        // Track edit operations separately
        if (isWriteToolCall(tc.name, tc.fullArgs) || tc.name === "str_replace_based_edit_tool") {
          editFile = targetFile;
          consecutiveEditCount = 1;
        }
      } else {
        // Last call has no target file (like yarn build)
        // This means the most recent operation is NOT a file-based operation
        // So there's no file-based loop happening right now
        // Return count = 0 (no similar file calls)
        break;
      }
      continue;
    }

    // For subsequent iterations, check if this is the SAME file as we're tracking
    if (targetFile && targetFile === currentFile) {
      // SAME file - increment count
      consecutiveFileCount++;
      
      if ((isWriteToolCall(tc.name, tc.fullArgs) || tc.name === "str_replace_based_edit_tool") && targetFile === editFile) {
        consecutiveEditCount++;
      }
    } else {
      // DIFFERENT file OR DIFFERENT command type (no target file like yarn build)
      // This is the key fix: ANY different operation breaks the chain
      // Examples:
      // - view fileA → view fileB → view fileA: breaks at fileB
      // - view fileA → yarn build → view fileA: breaks at yarn build
      // - view fileA → grep something → view fileA: breaks at grep (if grep has different target)
      break;
    }
  }

  // Check for edit loop (same file edited multiple times consecutively)
  if (consecutiveEditCount >= LOOP_DETECTION_CONFIG.EDIT_LOOP_THRESHOLD) {
    return {
      isSimilar: true,
      count: consecutiveEditCount,
      targetFile: editFile,
      isEditLoop: true,
      editCount: consecutiveEditCount,
    };
  }

  // Check for similar calls (same file accessed multiple times consecutively)
  // IMPORTANT: Only trigger for WRITE operations or if count is very high
  // Reading the same file multiple times is often legitimate (understanding code)
  // But editing the same file 6+ times consecutively is suspicious
  
  // For READ operations: require higher threshold (10+) to trigger
  // For WRITE operations: use normal threshold (6)
  
  // Check if the consecutive calls are all READ operations
  // We need to check the calls that were counted, not just the last call
  // If consecutiveEditCount == 0, it means all consecutive calls were read-only
  const isAllReadOnly = consecutiveEditCount === 0;
  
  // If the consecutive calls are all READ operations, be more lenient
  // Agent might be reading the same file to understand different parts
  if (isAllReadOnly) {
    // For read-only operations, require 40+ consecutive calls to trigger (10 * 4 = 40)
    // This is higher than SIMILAR_TOOL_THRESHOLD (24) to avoid false positives
    const READ_ONLY_SIMILAR_THRESHOLD = 40;
    return {
      isSimilar: consecutiveFileCount >= READ_ONLY_SIMILAR_THRESHOLD,
      count: consecutiveFileCount,
      targetFile: currentFile,
      isEditLoop: false,
      editCount: consecutiveEditCount,
    };
  }

  // For write operations, use normal threshold
  return {
    isSimilar: consecutiveFileCount >= LOOP_DETECTION_CONFIG.SIMILAR_TOOL_THRESHOLD,
    count: consecutiveFileCount,
    targetFile: currentFile,
    isEditLoop: false,
    editCount: consecutiveEditCount,
  };
}

/**
 * Detects read-edit-fail loop pattern
 * Pattern: cat file.ts → str_replace file.ts (fail) → cat file.ts → str_replace file.ts (fail)
 * This is a common pattern when agent is stuck trying to edit a file
 *
 * Fixed: Use tool_call_id matching instead of index-based matching to handle parallel calls correctly
 */
function detectReadEditFailLoop(
  toolCalls: ToolCallSignature[],
  messages: BaseMessage[],
): {
  isReadEditLoop: boolean;
  targetFile: string | null;
  cycleCount: number;
} {
  if (toolCalls.length < 4) {
    return { isReadEditLoop: false, targetFile: null, cycleCount: 0 };
  }

  const toolCallsWithResults = extractToolCallsWithResults(messages);

  // Build a map of tool signature to results for accurate matching
  // Key: name + argsHash, Value: array of results (for multiple calls with same signature)
  const signatureToResults = new Map<string, ToolCallWithResult[]>();
  for (const tc of toolCallsWithResults) {
    const key = `${tc.name}:${tc.argsHash}`;
    if (!signatureToResults.has(key)) {
      signatureToResults.set(key, []);
    }
    signatureToResults.get(key)!.push(tc);
  }

  const recentCalls = toolCalls.slice(-10);

  // Look for pattern: read → edit(fail) → read → edit(fail)
  // Track file → [read_count, edit_fail_count]
  const filePatterns = new Map<string, { reads: number; editFails: number }>();

  for (const tc of recentCalls) {
    const targetFile = extractTargetFile(tc.name, tc.fullArgs);

    if (!targetFile) continue;

    if (!filePatterns.has(targetFile)) {
      filePatterns.set(targetFile, { reads: 0, editFails: 0 });
    }

    const pattern = filePatterns.get(targetFile)!;

    if (isReadOnlyToolCall(tc.name, tc.fullArgs)) {
      pattern.reads++;
    } else if (tc.name === "str_replace_based_edit_tool") {
      // Check if this specific call failed
      const key = `${tc.name}:${tc.argsHash}`;
      const results = signatureToResults.get(key) || [];
      // Check if any result for this signature is an error
      const hasError = results.some((r) => r.status === "error");
      if (hasError) {
        pattern.editFails++;
      }
    }
  }

  // Find file with read-edit-fail pattern
  for (const [file, pattern] of filePatterns) {
    // If we have multiple reads AND multiple edit fails on same file, it's a read-edit-fail loop
    if (pattern.reads >= 2 && pattern.editFails >= 2) {
      return {
        isReadEditLoop: true,
        targetFile: file,
        cycleCount: Math.min(pattern.reads, pattern.editFails),
      };
    }
  }

  return { isReadEditLoop: false, targetFile: null, cycleCount: 0 };
}

/**
 * Detects frequency-based loops (same tool called too often in window)
 * Improved: Don't trigger if reading many different files
 * Enhanced: Better handling of shell commands - distinguish different commands
 */
function detectFrequencyLoop(toolCalls: ToolCallSignature[]): {
  isFrequent: boolean;
  toolName: string | null;
  count: number;
} {
  if (toolCalls.length < LOOP_DETECTION_CONFIG.FREQUENCY_WINDOW) {
    return { isFrequent: false, toolName: null, count: 0 };
  }

  const recentCalls = toolCalls.slice(-LOOP_DETECTION_CONFIG.FREQUENCY_WINDOW);

  // Count tool usage - with better shell command normalization
  const toolCount = new Map<string, number>();
  // Track unique targets per tool
  const toolTargets = new Map<string, Set<string>>();
  // Track unique full shell commands (for diversity check)
  const uniqueShellCommands = new Set<string>();
  // Track identical shell commands (exact same command)
  const identicalShellCommands = new Map<string, number>();

  for (const tc of recentCalls) {
    let toolKey = tc.name;

    if (tc.name === "shell" && typeof tc.fullArgs.command === "string") {
      const fullCommand = tc.fullArgs.command.trim();
      const parts = fullCommand.split(/\s+/);
      const baseCmd = parts[0];

      // Track unique full commands for diversity check
      uniqueShellCommands.add(fullCommand);

      // Track identical commands
      identicalShellCommands.set(
        fullCommand,
        (identicalShellCommands.get(fullCommand) || 0) + 1,
      );

      // For frequency counting, use more specific key:
      // - For yarn/npm/pnpm: include the subcommand (yarn lint, yarn build, etc.)
      // - For other commands: include first 2 parts or the whole command if short
      if (["yarn", "npm", "pnpm", "npx"].includes(baseCmd)) {
        // Include subcommand: yarn lint, yarn build, yarn test, etc.
        const subCmd = parts.slice(0, 3).join(" "); // e.g., "yarn run lint" or "yarn lint"
        toolKey = `shell:${subCmd}`;
      } else if (
        ["cat", "head", "tail", "grep", "ls", "find"].includes(baseCmd)
      ) {
        // For read commands, use base command only (target file tracked separately)
        toolKey = `shell:${baseCmd}`;
      } else {
        // For other commands, use first 2 parts
        toolKey = `shell:${parts.slice(0, 2).join(" ")}`;
      }
    }

    toolCount.set(toolKey, (toolCount.get(toolKey) || 0) + 1);

    // Track unique targets
    const target = extractTargetFile(tc.name, tc.fullArgs);
    if (target) {
      if (!toolTargets.has(toolKey)) {
        toolTargets.set(toolKey, new Set());
      }
      toolTargets.get(toolKey)!.add(target);
    }
  }

  // If there are many unique shell commands, it's legitimate work, not a loop
  // This handles cases where agent runs: yarn lint, yarn build, yarn test, etc.
  if (
    uniqueShellCommands.size >= LOOP_DETECTION_CONFIG.MIN_UNIQUE_SHELL_COMMANDS
  ) {
    // Check if any single command is repeated too many times
    let maxIdenticalCount = 0;
    let maxIdenticalCmd = "";
    for (const [cmd, count] of identicalShellCommands) {
      if (count > maxIdenticalCount) {
        maxIdenticalCount = count;
        maxIdenticalCmd = cmd;
      }
    }

    // Only flag as loop if same exact command repeated many times
    // AND it's more than half of all shell commands
    const totalShellCalls = recentCalls.filter(
      (tc) => tc.name === "shell",
    ).length;
    if (
      maxIdenticalCount >= LOOP_DETECTION_CONFIG.FREQUENCY_THRESHOLD &&
      maxIdenticalCount > totalShellCalls * 0.6
    ) {
      return {
        isFrequent: true,
        toolName: `shell:${maxIdenticalCmd.substring(0, 50)}`,
        count: maxIdenticalCount,
      };
    }

    // Many unique commands = legitimate work
    return { isFrequent: false, toolName: null, count: 0 };
  }

  // Find most frequent tool
  let maxTool: string | null = null;
  let maxCount = 0;

  for (const [tool, count] of toolCount) {
    if (count > maxCount) {
      maxCount = count;
      maxTool = tool;
    }
  }

  // If the most frequent tool is reading many different files, it's not a loop
  if (maxTool) {
    const uniqueTargets = toolTargets.get(maxTool)?.size || 0;
    // If reading at least 50% unique files, it's legitimate exploration
    if (uniqueTargets >= maxCount * 0.5) {
      return { isFrequent: false, toolName: null, count: 0 };
    }
  }

  return {
    isFrequent: maxCount >= LOOP_DETECTION_CONFIG.FREQUENCY_THRESHOLD,
    toolName: maxTool,
    count: maxCount,
  };
}

/**
 * Detects if recent tool calls are all errors (error retry loop)
 * Improved: Use tool call results directly
 * Also detects "partial success loop" where agent succeeds then fails repeatedly
 */
function detectErrorRetryLoop(
  toolCalls: ToolCallSignature[],
  messages: BaseMessage[],
): boolean {
  if (toolCalls.length < 3) {
    return false;
  }

  const toolCallsWithResults = extractToolCallsWithResults(messages);
  if (
    toolCallsWithResults.length < LOOP_DETECTION_CONFIG.MIN_CALLS_FOR_ERROR_RATE
  ) {
    return false;
  }

  // Check last N tool calls for error rate
  const recentCalls = toolCallsWithResults.slice(
    -LOOP_DETECTION_CONFIG.MIN_CALLS_FOR_ERROR_RATE,
  );
  const errorCount = recentCalls.filter((tc) => tc.status === "error").length;

  // If ERROR_RATE_THRESHOLD+ of recent calls are errors, it's an error retry loop
  return (
    errorCount >=
    Math.ceil(recentCalls.length * LOOP_DETECTION_CONFIG.ERROR_RATE_THRESHOLD)
  );
}

/**
 * Determines the type of loop detected
 */
function determineLoopType(
  toolCalls: ToolCallSignature[],
  messages: BaseMessage[],
  consecutiveCount: number,
): LoopType {
  // First check for consecutive identical calls (most severe)
  if (consecutiveCount >= LOOP_DETECTION_CONFIG.LOOP_THRESHOLD) {
    // Check if it's an error retry loop
    if (detectErrorRetryLoop(toolCalls, messages)) {
      return "error_retry";
    }

    // Check if it's a verification loop (read-only operations)
    const lastCall = toolCalls[toolCalls.length - 1];
    if (lastCall && isReadOnlyToolCall(lastCall.name, lastCall.fullArgs)) {
      return "verification";
    }

    return "unknown";
  }

  // Check for chanting (model repeating same content)
  const { isChanting } = detectChanting(messages);
  if (isChanting) {
    return "chanting";
  }

  // Check for read-edit-fail loop (cat → edit fail → cat → edit fail)
  const { isReadEditLoop } = detectReadEditFailLoop(toolCalls, messages);
  if (isReadEditLoop) {
    return "edit_loop";
  }

  // Check for tool switching loop (str_replace fail → apply_patch fail → ...)
  const { isToolSwitching } = detectToolSwitchingLoop(toolCalls, messages);
  if (isToolSwitching) {
    return "edit_loop"; // Treat as edit_loop since it's the same underlying issue
  }

  // Check for alternating pattern
  const { isAlternating } = detectAlternatingPattern(toolCalls);
  if (isAlternating) {
    return "alternating";
  }

  // Check for similar tool calls (same file, different commands)
  const { isSimilar, isEditLoop } = detectSimilarToolCalls(toolCalls);
  if (isEditLoop) {
    return "edit_loop";
  }
  if (isSimilar) {
    return "similar_calls";
  }

  // Check for frequency-based loop
  const { isFrequent } = detectFrequencyLoop(toolCalls);
  if (isFrequent) {
    return "frequency";
  }

  // Check for delayed loop (same action repeated non-consecutively)
  const { isDelayedLoop } = detectDelayedLoop(toolCalls);
  if (isDelayedLoop) {
    return "similar_calls"; // Treat as similar_calls
  }

  // Check for read-only loop
  if (detectReadOnlyLoop(toolCalls)) {
    return "read_only";
  }

  return "none";
}

/**
 * Determines the recommended action based on loop type and count
 *
 * Escalation strategy:
 * 1. warn - inject warning into prompt
 * 2. request_help - ask human for guidance (for error loops)
 * 3. force_complete - force mark task as completed
 *
 * Edit loops (str_replace failing) are treated more severely because
 * they indicate the agent is fundamentally stuck and needs human help.
 *
 * Warning count is used for escalation - if warned multiple times without
 * changing behavior, escalate to more severe action.
 */
function determineRecommendation(
  loopType: LoopType,
  consecutiveCount: number,
  isAlternating: boolean,
  similarCallsCount: number,
  frequencyCount: number,
  hasRecentHelp: boolean,
  isEditLoop: boolean,
  hasVaryingOutputs: boolean,
  warningCount: number = 0,
): LoopRecommendation {
  // No loop detected
  if (loopType === "none") {
    return "continue";
  }

  // If we've warned multiple times and agent is still looping, escalate
  // This handles cases where agent ignores warnings
  if (warningCount >= LOOP_DETECTION_CONFIG.MAX_WARNINGS_BEFORE_ESCALATE) {
    logger.warn("Escalating due to multiple ignored warnings", {
      warningCount,
      loopType,
      consecutiveCount,
    });
    if (hasRecentHelp) {
      return "force_complete";
    }
    return "request_help";
  }

  // If outputs are varying significantly, be more lenient
  // This is from Gemini CLI Issue #11002 - output comparison
  if (
    hasVaryingOutputs &&
    loopType !== "chanting" &&
    loopType !== "edit_loop"
  ) {
    // Only warn, don't force complete if outputs are different
    if (consecutiveCount >= LOOP_DETECTION_CONFIG.FORCE_COMPLETION_THRESHOLD) {
      return "warn";
    }
    return "continue";
  }

  // Chanting - force complete immediately (model is broken)
  if (loopType === "chanting") {
    return "force_complete";
  }

  // Edit loop (str_replace failing repeatedly) - request help early
  // This is from Gemini CLI Issue #5761 and Aider Issue #770
  if (loopType === "edit_loop" || isEditLoop) {
    if (consecutiveCount >= LOOP_DETECTION_CONFIG.EDIT_LOOP_THRESHOLD) {
      if (hasRecentHelp) {
        return "force_complete";
      }
      return "request_help";
    }
    return "warn";
  }

  // Error retry loop - request help instead of force complete
  // But don't request help again if already requested recently
  if (loopType === "error_retry") {
    if (consecutiveCount >= LOOP_DETECTION_CONFIG.FORCE_COMPLETION_THRESHOLD) {
      if (hasRecentHelp) {
        // Already requested help, force complete to avoid infinite loop
        return "force_complete";
      }
      return "request_help";
    }
    return "warn";
  }

  // Alternating pattern - warn for 4-element, force complete for 6-element
  if (loopType === "alternating" || isAlternating) {
    if (consecutiveCount >= 6) {
      return "force_complete";
    }
    return "warn";
  }

  // Similar calls (same file, different commands) - warn first
  if (loopType === "similar_calls") {
    if (
      similarCallsCount >=
      LOOP_DETECTION_CONFIG.FORCE_COMPLETION_THRESHOLD + 1
    ) {
      return "force_complete";
    }
    return "warn";
  }

  // Frequency-based loop - warn first
  if (loopType === "frequency") {
    if (frequencyCount >= LOOP_DETECTION_CONFIG.FREQUENCY_THRESHOLD + 2) {
      return "force_complete";
    }
    return "warn";
  }

  // Verification or read-only loop - can force complete
  if (loopType === "verification" || loopType === "read_only") {
    if (consecutiveCount >= LOOP_DETECTION_CONFIG.FORCE_COMPLETION_THRESHOLD) {
      return "force_complete";
    }
    return "warn";
  }

  // Unknown loop type - be more conservative
  if (
    consecutiveCount >=
    LOOP_DETECTION_CONFIG.FORCE_COMPLETION_THRESHOLD + 2
  ) {
    return "force_complete";
  }
  if (consecutiveCount >= LOOP_DETECTION_CONFIG.LOOP_THRESHOLD) {
    return "warn";
  }

  return "continue";
}

/**
 * Main loop detection function - analyzes messages for loop patterns
 *
 * This function implements comprehensive loop detection based on research from:
 * - Claude Code Issue #4277: Tool Call Loops + Content Loops (Chanting)
 * - Gemini CLI Issue #11002: Output comparison for false positive reduction
 * - Gemini CLI Issue #5761: str_replace_based_edit_tool specific errors
 * - Aider Issue #770: Edit format errors causing stuck loops
 * - Cursor: "Unrecoverable agent model looping detected"
 */
export function detectLoop(messages: BaseMessage[]): LoopDetectionResult {
  const toolCalls = extractRecentToolCalls(messages);

  // Early return if not enough tool calls to analyze
  if (toolCalls.length < 2) {
    return {
      isLooping: false,
      loopCount: 0,
      repeatedToolCall: null,
      shouldForceCompletion: false,
      loopType: "none",
      recommendation: "continue",
      isEditLoop: false,
      hasVaryingOutputs: false,
      warningCount: 0,
    };
  }

  // Check for legitimate build-fix-retry pattern first (not a loop)
  // This prevents false positives when agent is fixing build errors
  if (isLegitimateBuildFixRetry(messages)) {
    logger.info(
      "Detected legitimate build-fix-retry pattern, skipping loop detection",
    );
    return {
      isLooping: false,
      loopCount: 0,
      repeatedToolCall: null,
      shouldForceCompletion: false,
      loopType: "none",
      recommendation: "continue",
      isEditLoop: false,
      hasVaryingOutputs: true, // Mark as varying to indicate progress
      warningCount: 0,
    };
  }

  const {
    count: consecutiveCount,
    signature,
    hasVaryingOutputs,
  } = countConsecutiveIdenticalCalls(toolCalls, messages);
  const { isAlternating, patternLength, cycleType } =
    detectAlternatingPattern(toolCalls);
  const {
    isSimilar,
    count: similarCount,
    targetFile,
    isEditLoop,
    editCount,
  } = detectSimilarToolCalls(toolCalls);
  const {
    isFrequent,
    count: frequencyCount,
    toolName: frequentTool,
  } = detectFrequencyLoop(toolCalls);
  const { isToolSwitching, switchCount } = detectToolSwitchingLoop(
    toolCalls,
    messages,
  );
  const { isDelayedLoop, occurrences: delayedCount } =
    detectDelayedLoop(toolCalls);
  const hasRecentHelp = hasRecentHelpRequest(messages);

  // If outputs are varying, reduce the effective count (agent might be making progress)
  // This helps avoid false positives for legitimate retry scenarios like build/test
  // From Gemini CLI Issue #11002
  let adjustedConsecutiveCount = consecutiveCount;
  if (
    hasVaryingOutputs &&
    consecutiveCount >= LOOP_DETECTION_CONFIG.LOOP_THRESHOLD
  ) {
    // Require higher threshold if outputs are different
    adjustedConsecutiveCount = Math.max(1, consecutiveCount - 2);
    logger.info("Outputs are varying, adjusting consecutive count", {
      originalCount: consecutiveCount,
      adjustedCount: adjustedConsecutiveCount,
    });
  }

  // Determine loop type - check for edit_loop specifically
  let loopType = determineLoopType(
    toolCalls,
    messages,
    adjustedConsecutiveCount,
  );

  // Override to edit_loop if detected (more severe handling)
  if ((isEditLoop || isToolSwitching) && loopType !== "chanting") {
    loopType = "edit_loop";
  }

  // Determine effective count based on loop type
  let effectiveCount = consecutiveCount;
  if (isAlternating) {
    effectiveCount = patternLength;
  } else if (loopType === "edit_loop") {
    // For edit loops, use the edit count or switch count specifically
    effectiveCount = Math.max(editCount, switchCount);
  } else if (loopType === "similar_calls") {
    effectiveCount = Math.max(similarCount, delayedCount);
  } else if (loopType === "frequency") {
    effectiveCount = frequencyCount;
  }

  const isLooping = loopType !== "none";

  // Count previous warnings (for escalation tracking)
  const warningCount = countPreviousWarnings(messages);

  const recommendation = determineRecommendation(
    loopType,
    effectiveCount,
    isAlternating,
    similarCount,
    frequencyCount,
    hasRecentHelp,
    isEditLoop,
    hasVaryingOutputs,
    warningCount,
  );
  const shouldForceCompletion = recommendation === "force_complete";

  // Build signature for reporting
  let reportSignature = signature;
  if (
    (loopType === "similar_calls" || loopType === "edit_loop") &&
    targetFile
  ) {
    reportSignature = {
      name: `file:${targetFile}`,
      argsHash: "",
      fullArgs: {},
    };
  } else if (loopType === "frequency" && frequentTool) {
    reportSignature = {
      name: frequentTool,
      argsHash: "",
      fullArgs: {},
    };
  }

  // Log detection results
  if (isLooping) {
    logger.warn("Loop detected in agent behavior", {
      loopType,
      loopCount: effectiveCount,
      toolName: reportSignature?.name,
      isAlternating,
      cycleType,
      isSimilar,
      isEditLoop,
      isToolSwitching,
      isDelayedLoop,
      isFrequent,
      hasRecentHelp,
      hasVaryingOutputs,
      warningCount,
      recommendation,
      threshold: LOOP_DETECTION_CONFIG.LOOP_THRESHOLD,
      forceCompletionThreshold:
        LOOP_DETECTION_CONFIG.FORCE_COMPLETION_THRESHOLD,
    });
  } else {
    // Debug log for non-loop cases (only if there are enough tool calls)
    if (toolCalls.length >= LOOP_DETECTION_CONFIG.LOOP_THRESHOLD) {
      logger.info("Loop detection check passed", {
        toolCallCount: toolCalls.length,
        consecutiveCount,
        lastToolName: signature?.name,
      });
    }
  }

  return {
    isLooping,
    loopCount: effectiveCount,
    repeatedToolCall: reportSignature,
    shouldForceCompletion,
    loopType,
    recommendation,
    isEditLoop,
    hasVaryingOutputs,
    warningCount,
  };
}

/**
 * Counts previous loop warnings in messages (for escalation tracking)
 * Warnings are injected into HumanMessage via {LOOP_WARNING} placeholder
 */
function countPreviousWarnings(messages: BaseMessage[]): number {
  let count = 0;
  const recentMessages = messages.slice(-20);

  for (const message of recentMessages) {
    // Check HumanMessage content for loop warnings (injected via formatSpecificPlanPrompt)
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((c) => (typeof c === "string" ? c : (c as any).text || ""))
              .join(" ")
          : "";

    if (
      content.includes("CRITICAL_LOOP_WARNING") ||
      content.includes("LOOP DETECTED")
    ) {
      count++;
    }
  }

  return count;
}

/**
 * Generates a warning prompt based on loop type
 */
export function generateLoopWarningPrompt(result: LoopDetectionResult): string {
  if (!result.isLooping) {
    return "";
  }

  const toolName = result.repeatedToolCall?.name || "unknown";

  let specificGuidance = "";
  switch (result.loopType) {
    case "verification":
      specificGuidance = `
You appear to be stuck in a VERIFICATION LOOP - repeatedly reading the same file/content to verify your work.
If you've already verified the changes are correct, call \`mark_task_completed\` immediately.
If something is wrong, take a DIFFERENT action to fix it.`;
      break;

    case "error_retry":
      specificGuidance = `
You appear to be stuck in an ERROR RETRY LOOP - the same command keeps failing.
STOP retrying the same approach. Either:
1. Try a completely different approach to solve the problem
2. Call \`request_human_help\` if you're stuck and need guidance`;
      break;

    case "alternating":
      specificGuidance = `
You appear to be stuck in an ALTERNATING LOOP - switching between the same actions repeatedly.
This could be:
- Alternating between two identical tool calls (A→B→A→B)
- Oscillating between editing the same files repeatedly
- A 3-element cycle (A→B→C→A→B→C)

This indicates you're not making progress. Either:
1. Complete the task and call \`mark_task_completed\`
2. Take a completely different approach
3. If you're stuck fixing something, call \`request_human_help\``;
      break;

    case "read_only":
      specificGuidance = `
You appear to be stuck in a READ-ONLY LOOP - only reading files without making changes.
If you're gathering information, you should have enough by now.
Either make the necessary changes or call \`mark_task_completed\` if the task is done.`;
      break;

    case "similar_calls":
      specificGuidance = `
You appear to be stuck reading/editing the same file (${toolName}) multiple times with different commands.
You've already seen or modified this file's content. Either:
1. Make the final changes you need to make
2. Call \`mark_task_completed\` if the task is done
3. Move on to a different file if needed
4. If your edits keep failing, try a different approach or call \`request_human_help\``;
      break;

    case "frequency":
      specificGuidance = `
You are calling "${toolName}" too frequently (${result.loopCount} times recently).
This suggests you may be stuck. Either:
1. Complete the task and call \`mark_task_completed\`
2. Try a different approach
3. Call \`request_human_help\` if you need guidance`;
      break;

    case "chanting":
      specificGuidance = `
You appear to be generating the same content repeatedly (CHANTING).
This indicates a serious issue. You MUST:
1. STOP and take a completely different action
2. Call \`mark_task_completed\` if the task is done
3. Call \`request_human_help\` if you're confused`;
      break;

    case "edit_loop":
      specificGuidance = `
You appear to be stuck in an EDIT LOOP - your file edits keep failing (str_replace_based_edit_tool errors).

COMMON CAUSES (from Cline Issue #2909 and Gemini CLI Issue #5761):
- Whitespace mismatch: spaces vs tabs, trailing spaces, inconsistent indentation
- Line ending differences: LF (Unix) vs CRLF (Windows)
- Hidden characters: BOM (Byte Order Mark) at file start
- File content changed between your read and edit attempt
- Incorrect escaping of special characters

STOP trying the same edit. Instead:
1. Read the file again with \`cat\` to see the EXACT current content
2. Pay attention to:
   - Exact indentation (count spaces/tabs)
   - Line endings (check if file uses \\r\\n or \\n)
   - Any trailing whitespace
3. Copy the EXACT text you want to replace character-by-character
4. If edits keep failing after 3 attempts, use a different approach:
   - Write the entire file content instead of patching
   - Use \`apply_patch\` tool instead
   - Call \`request_human_help\` for guidance
5. If the task is actually complete, call \`mark_task_completed\``;
      break;

    default:
      specificGuidance = `
You appear to be stuck in a loop. Please:
1. STOP calling the same tool repeatedly
2. Either complete the task or take a different action`;
  }

  return `
<CRITICAL_LOOP_WARNING>
⚠️ LOOP DETECTED (${result.loopType.toUpperCase()}): You have repeated similar actions ${result.loopCount} times.
${specificGuidance}

DO NOT continue with the same pattern. Your next action MUST be different:
- Call \`mark_task_completed\` if the task is done
- Call \`request_human_help\` if you're stuck
- Take a completely different approach if more work is needed
</CRITICAL_LOOP_WARNING>
`;
}

/**
 * Utility to check if a proposed tool call should be skipped
 */
export function shouldSkipDueToLoop(
  messages: BaseMessage[],
  proposedToolName: string,
  proposedArgs: Record<string, unknown>,
): boolean {
  const toolCalls = extractRecentToolCalls(messages);
  if (toolCalls.length === 0) {
    return false;
  }

  const lastCall = toolCalls[toolCalls.length - 1];
  const proposedHash = hashToolCallArgs(proposedArgs);

  if (
    lastCall.name === proposedToolName &&
    lastCall.argsHash === proposedHash
  ) {
    const { count } = countConsecutiveIdenticalCalls(toolCalls);
    return count >= LOOP_DETECTION_CONFIG.LOOP_THRESHOLD;
  }

  return false;
}

/**
 * Detects legitimate "build-fix-retry" pattern
 * Pattern: build/test → fail → edit file → build/test → fail → edit file → ...
 * This is NOT a loop - agent is making progress by fixing errors
 *
 * Returns true if the pattern is legitimate (should NOT trigger loop detection)
 *
 * Improved: Also check that edits are actually different (not repeating same edit)
 * Enhanced: Check for "progressive edit loop" - edits that are similar but not identical
 */
export function isLegitimateBuildFixRetry(messages: BaseMessage[]): boolean {
  const toolCalls = extractRecentToolCalls(messages);
  if (toolCalls.length < 4) {
    return false;
  }

  const recentCalls = toolCalls.slice(-10);

  // Look for pattern: build/test command → edit → build/test command → edit
  let buildCount = 0;
  let editCount = 0;
  let lastWasBuild = false;
  const editHashes = new Set<string>(); // Track unique edits
  const editContents: string[] = []; // Track edit content for similarity check

  for (const tc of recentCalls) {
    const isBuildCommand =
      tc.name === "shell" &&
      typeof tc.fullArgs.command === "string" &&
      /^(npm|yarn|pnpm)\s+(run\s+)?(build|test|lint|check|compile|tsc)/.test(
        tc.fullArgs.command.trim(),
      );

    const isEditCommand =
      tc.name === "str_replace_based_edit_tool" || tc.name === "apply_patch";

    if (isBuildCommand) {
      buildCount++;
      lastWasBuild = true;
    } else if (isEditCommand && lastWasBuild) {
      editCount++;
      editHashes.add(tc.argsHash); // Track unique edit content

      // Also track the actual edit content for similarity check
      if (tc.name === "str_replace_based_edit_tool") {
        const newStr = (tc.fullArgs.new_str as string) || "";
        editContents.push(newStr);
      }

      lastWasBuild = false;
    }
  }

  // If we have alternating build→edit pattern, it's legitimate
  // At least 2 build commands and 2 edits in between
  // AND edits must be different (not repeating same edit)
  const hasUniqueEdits = editHashes.size >= Math.max(1, editCount - 1); // Allow 1 repeat

  // Additional check: if edits are too similar (progressive edit loop), it's not legitimate
  // This catches cases where agent makes tiny changes each time but doesn't fix the issue
  if (editContents.length >= 3) {
    let similarPairs = 0;
    for (let i = 1; i < editContents.length; i++) {
      const similarity = calculateSimilarity(
        editContents[i - 1],
        editContents[i],
      );
      if (similarity > 0.8) {
        // 80% similar
        similarPairs++;
      }
    }
    // If most edits are very similar, it's a progressive edit loop, not legitimate
    if (similarPairs >= editContents.length - 1) {
      logger.info("Detected progressive edit loop - edits are too similar", {
        editCount,
        similarPairs,
      });
      return false;
    }
  }

  return buildCount >= 2 && editCount >= 2 && hasUniqueEdits;
}

/**
 * Gets a summary of loop detection state for debugging
 */
export function getLoopDetectionSummary(messages: BaseMessage[]): {
  totalToolCalls: number;
  uniqueTools: string[];
  consecutiveIdenticalCount: number;
  lastToolName: string | null;
  isInLoop: boolean;
  loopType: LoopType;
  recommendation: LoopRecommendation;
} {
  const result = detectLoop(messages);
  const toolCalls = extractRecentToolCalls(messages);
  const uniqueTools = [...new Set(toolCalls.map((tc) => tc.name))];

  return {
    totalToolCalls: toolCalls.length,
    uniqueTools,
    consecutiveIdenticalCount: result.loopCount,
    lastToolName: result.repeatedToolCall?.name || null,
    isInLoop: result.isLooping,
    loopType: result.loopType,
    recommendation: result.recommendation,
  };
}
