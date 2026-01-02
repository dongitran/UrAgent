import { UseStream } from "@langchain/langgraph-sdk/react";
import { PlannerGraphState } from "@openswe/shared/open-swe/planner/types";
import { GraphState, AgentSession } from "@openswe/shared/open-swe/types";
import { useState } from "react";
import { toast } from "sonner";

interface UseCancelStreamProps<State extends PlannerGraphState | GraphState> {
  stream: UseStream<State>;
  threadId?: string;
  runId?: string;
  streamName: "Planner" | "Programmer";
  // Optional: programmer session to cancel when cancelling planner
  programmerSession?: AgentSession;
}

export function useCancelStream<State extends PlannerGraphState | GraphState>({
  stream,
  threadId,
  runId,
  streamName,
  programmerSession,
}: UseCancelStreamProps<State>) {
  const [cancelLoading, setCancelLoading] = useState(false);
  const cancelRun = async () => {
    if (!threadId || !runId) {
      toast.error(`Cannot cancel ${streamName}: Missing thread or run ID`);
      return;
    }

    try {
      setCancelLoading(true);
      
      // Cancel the main run
      await stream.client.runs.cancel(threadId, runId, true);
      
      // If cancelling planner and there's an active programmer session, cancel it too
      if (streamName === "Planner" && programmerSession?.threadId && programmerSession?.runId) {
        try {
          await stream.client.runs.cancel(programmerSession.threadId, programmerSession.runId, true);
          toast.success("Planner and Programmer cancelled successfully", {
            description: "Both running operations have been stopped",
            duration: 5000,
            richColors: true,
          });
        } catch (programmerError) {
          // Programmer might already be stopped, log but don't fail
          console.warn("Failed to cancel programmer run (may already be stopped):", programmerError);
          toast.success(`${streamName} cancelled successfully`, {
            description: "The running operation has been stopped",
            duration: 5000,
            richColors: true,
          });
        }
      } else {
        toast.success(`${streamName} cancelled successfully`, {
          description: "The running operation has been stopped",
          duration: 5000,
          richColors: true,
        });
      }
    } catch (error) {
      const errorStr = String(error);
      const isAbortError = errorStr.toLowerCase().includes("abort");

      if (isAbortError) {
        toast.info(`${streamName} operation cancelled`, {
          description: "The stream was successfully stopped",
          duration: 5000,
          richColors: true,
        });
      } else {
        console.error(`Error cancelling ${streamName} run:`, error);
        toast.error(`Failed to cancel ${streamName}`, {
          description: errorStr || "Unknown error occurred",
          duration: 5000,
          richColors: true,
        });
      }
    } finally {
      setCancelLoading(false);
    }
  };

  return { cancelRun, cancelLoading };
}
