import { GraphConfig } from "@openswe/shared/open-swe/types";
import { createLangGraphClient } from "./langgraph-client.js";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "RunCancellation");

/**
 * Check if the current run has been cancelled by the user.
 * This is used to prevent executing actions after the user has stopped the run.
 * 
 * @param config - The graph configuration containing thread_id and run_id
 * @returns true if the run has been cancelled, false otherwise
 */
export async function isRunCancelled(config: GraphConfig): Promise<boolean> {
    const threadId = config.configurable?.thread_id;
    const runId = config.configurable?.run_id;

    if (!threadId || !runId) {
        return false;
    }

    try {
        const client = createLangGraphClient();
        const run = await client.runs.get(threadId, runId);

        // Check if run status indicates cancellation
        const cancelledStatuses = ["cancelled", "interrupted", "error"];
        const isCancelled = cancelledStatuses.includes(run.status);

        if (isCancelled) {
            logger.info("Run has been cancelled by user", {
                threadId,
                runId,
                status: run.status,
            });
        }

        return isCancelled;
    } catch (error) {
        // If we can't check the run status, assume it's not cancelled
        // This prevents blocking the workflow due to API errors
        logger.warn("Failed to check run cancellation status", {
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}
