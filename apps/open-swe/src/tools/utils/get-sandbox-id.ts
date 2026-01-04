import { getCurrentTaskInput } from "@langchain/langgraph";
import { GraphState } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { daytonaClient, getProvider } from "../../utils/sandbox.js";
import { Sandbox } from "@daytonaio/sdk";
import { ISandbox } from "../../utils/sandbox-provider/types.js";

const logger = createLogger(LogLevel.DEBUG, "GetSandboxSessionOrThrow");

/**
 * Get sandbox using the new provider abstraction
 * Returns ISandbox which is provider-agnostic
 */
export async function getSandboxInstanceOrThrow(
  input: Record<string, unknown>,
): Promise<ISandbox> {
  let sandboxSessionId = "";
  
  if ("xSandboxSessionId" in input && input.xSandboxSessionId) {
    sandboxSessionId = input.xSandboxSessionId as string;
    logger.debug("[SANDBOX] Extracted sandboxSessionId from input", {
      sandboxSessionId,
      source: "xSandboxSessionId",
    });
  } else {
    const state = getCurrentTaskInput<GraphState>();
    sandboxSessionId = state.sandboxSessionId;
    logger.debug("[SANDBOX] Extracted sandboxSessionId from state", {
      sandboxSessionId,
      source: "GraphState",
    });
  }

  if (!sandboxSessionId) {
    logger.error(
      "[SANDBOX] FAILED TO RUN COMMAND: No sandbox session ID provided",
      { inputKeys: Object.keys(input) },
    );
    throw new Error("FAILED TO RUN COMMAND: No sandbox session ID provided");
  }

  logger.debug("[SANDBOX] Fetching sandbox from provider", {
    sandboxSessionId,
    timestamp: new Date().toISOString(),
  });

  const startTime = Date.now();
  try {
    const provider = getProvider();
    const sandbox = await provider.get(sandboxSessionId);
    const duration = Date.now() - startTime;

    logger.debug("[SANDBOX] Successfully fetched sandbox via provider", {
      sandboxSessionId,
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
      providerName: provider.name,
      durationMs: duration,
    });

    return sandbox;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("[SANDBOX] Failed to fetch sandbox from provider", {
      sandboxSessionId,
      durationMs: duration,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    });
    throw error;
  }
}

/**
 * Get sandbox using legacy Daytona client
 * @deprecated Use getSandboxInstanceOrThrow for provider-agnostic sandbox access
 */
export async function getSandboxSessionOrThrow(
  input: Record<string, unknown>,
): Promise<Sandbox> {
  let sandboxSessionId = "";
  // Attempt to extract from input.
  if ("xSandboxSessionId" in input && input.xSandboxSessionId) {
    sandboxSessionId = input.xSandboxSessionId as string;
    logger.debug("[DAYTONA] Extracted sandboxSessionId from input", {
      sandboxSessionId,
      source: "xSandboxSessionId",
    });
  } else {
    const state = getCurrentTaskInput<GraphState>();
    sandboxSessionId = state.sandboxSessionId;
    logger.debug("[DAYTONA] Extracted sandboxSessionId from state", {
      sandboxSessionId,
      source: "GraphState",
    });
  }

  if (!sandboxSessionId) {
    logger.error(
      "[DAYTONA] FAILED TO RUN COMMAND: No sandbox session ID provided",
      {
        inputKeys: Object.keys(input),
      },
    );
    throw new Error("FAILED TO RUN COMMAND: No sandbox session ID provided");
  }

  logger.debug("[DAYTONA] Fetching sandbox from Daytona API", {
    sandboxSessionId,
    timestamp: new Date().toISOString(),
  });

  const startTime = Date.now();
  try {
    const sandbox = await daytonaClient().get(sandboxSessionId);
    const duration = Date.now() - startTime;

    logger.debug("[DAYTONA] Successfully fetched sandbox", {
      sandboxSessionId,
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
      durationMs: duration,
    });

    return sandbox;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("[DAYTONA] Failed to fetch sandbox from Daytona API", {
      sandboxSessionId,
      durationMs: duration,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });
    throw error;
  }
}
