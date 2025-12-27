import { getCurrentTaskInput } from "@langchain/langgraph";
import { GraphState } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { daytonaClient } from "../../utils/sandbox.js";
import { Sandbox } from "@daytonaio/sdk";

const logger = createLogger(LogLevel.DEBUG, "GetSandboxSessionOrThrow");

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
    logger.error("[DAYTONA] FAILED TO RUN COMMAND: No sandbox session ID provided", {
      inputKeys: Object.keys(input),
    });
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
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
    });
    throw error;
  }
}
