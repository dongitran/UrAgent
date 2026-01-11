import { isAIMessageSDK, isHumanMessageSDK } from "@/lib/langchain-messages";
import { UseStream, useStream } from "@langchain/langgraph-sdk/react";
import { AssistantMessage } from "../thread/messages/ai";
import { Dispatch, SetStateAction, useEffect, useMemo, useState } from "react";
import {
  CustomNodeEvent,
  INITIALIZE_NODE_ID,
  ACCEPTED_PLAN_NODE_ID,
  mapCustomEventsToSteps,
  REQUEST_HELP_NODE_ID,
} from "@openswe/shared/open-swe/custom-node-events";
import { DO_NOT_RENDER_ID_PREFIX } from "@openswe/shared/constants";
import { Message } from "@langchain/langgraph-sdk";
import { InitializeStep } from "../gen-ui/initialize-step";
import { AcceptedPlanStep } from "../gen-ui/accepted-plan-step";
import { PlannerGraphState } from "@openswe/shared/open-swe/planner/types";
import { GraphState, PlanItem, TaskPlan } from "@openswe/shared/open-swe/types";
import { HumanResponse } from "@langchain/langgraph/prebuilt";
import { LoadingActionsCardContent } from "./thread-view-loading";
import { Interrupt } from "../thread/messages/interrupt";
import { AlertCircle } from "lucide-react";
import { ErrorState } from "./types";
import { CollapsibleAlert } from "./collapsible-alert";

interface AcceptedPlanEventData {
  planTitle: string;
  planItems: PlanItem[];
  interruptType: HumanResponse["type"];
}

type AcceptedPlanEvent = CustomNodeEvent & {
  data: AcceptedPlanEventData;
};

function isAcceptedPlanEvent(
  event: CustomNodeEvent,
): event is AcceptedPlanEvent {
  const { data } = event;
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.planTitle === "string" &&
    Array.isArray(data.planItems) &&
    data.planItems.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.index === "number" &&
        typeof item.plan === "string" &&
        typeof item.completed === "boolean",
    ) &&
    (data.interruptType === "accept" || data.interruptType === "edit")
  );
}

function isAcceptedPlanEvents(
  events: CustomNodeEvent[],
): events is AcceptedPlanEvent[] {
  return events.every(isAcceptedPlanEvent);
}

interface ActionsRendererProps<
  StateType extends PlannerGraphState | GraphState,
> {
  runId?: string;
  threadId: string;
  customNodeEvents: CustomNodeEvent[];
  setCustomNodeEvents: Dispatch<SetStateAction<CustomNodeEvent[]>>;
  stream: ReturnType<typeof useStream<StateType>>;
  taskPlan?: TaskPlan;
  modifyRunId?: (runId: string) => Promise<void>;
}

const getCustomNodeEventsFromMessages = (
  messages?: Message[],
  nodeId?: string,
): CustomNodeEvent[] => {
  if (!messages) return [];

  return messages
    .filter((m) => isAIMessageSDK(m))
    .filter((m) => {
      const events = m.additional_kwargs?.customNodeEvents as
        | CustomNodeEvent[]
        | undefined;
      if (!events?.length) return false;
      if (!nodeId) {
        return true;
      }
      return events.some((e) => e.nodeId === nodeId);
    })
    .map((m) => m.additional_kwargs?.customNodeEvents as CustomNodeEvent[])
    .flat();
};

export function ActionsRenderer<
  StateType extends PlannerGraphState | GraphState,
>({
  taskPlan,
  runId,
  customNodeEvents,
  setCustomNodeEvents,
  stream,
  threadId,
  modifyRunId,
}: ActionsRendererProps<StateType>) {
  const [streamLoading, setStreamLoading] = useState(stream.isLoading);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);

  const initializeEvents = useMemo(
    () =>
      customNodeEvents.filter(
        (e) => e.nodeId === INITIALIZE_NODE_ID && e.data.runId === runId,
      ),
    [customNodeEvents, runId],
  );

  const acceptedPlanEvents = useMemo(
    () =>
      customNodeEvents.filter(
        (e) => e.nodeId === ACCEPTED_PLAN_NODE_ID && e.data.runId === runId,
      ),
    [customNodeEvents, runId],
  );

  const requestHelpEvents = useMemo(
    () => customNodeEvents.filter((e) => e.nodeId === REQUEST_HELP_NODE_ID),
    [customNodeEvents],
  );

  const steps = mapCustomEventsToSteps(initializeEvents);
  const allSuccess =
    steps.length > 0 && steps.every((s) => s.status === "success");

  let initStatus: "loading" | "generating" | "done" = "generating";
  if (allSuccess) {
    initStatus = "done";
  }

  // Merge stream.messages with stream.values.messages to ensure all ToolMessages are available
  // During streaming, stream.messages may not contain all ToolMessages yet
  const streamValueMessages = (stream.values as Record<string, unknown>)?.messages as Message[] ?? [];
  const allMessages: Message[] = (() => {
    if (!stream.messages?.length) return streamValueMessages;
    if (!streamValueMessages?.length) return stream.messages;

    // Merge by ID to avoid duplicates, prefer stream.messages (more recent)
    const messageMap = new Map<string, Message>();
    [...streamValueMessages, ...stream.messages].forEach((m: Message) => {
      if (m.id) messageMap.set(m.id, m);
    });
    return Array.from(messageMap.values());
  })();

  // Filter out human & do not render messages
  const filteredMessages = allMessages?.filter(
    (m) =>
      !isHumanMessageSDK(m) &&
      !(m.id && m.id.startsWith(DO_NOT_RENDER_ID_PREFIX)),
  );
  const isLastMessageHidden = !!(
    stream.messages?.length > 0 &&
    stream.messages[stream.messages.length - 1].id &&
    stream.messages[stream.messages.length - 1].id?.startsWith(
      DO_NOT_RENDER_ID_PREFIX,
    )
  );

  useEffect(() => {
    const allCustomEvents = getCustomNodeEventsFromMessages(stream.messages);
    if (!allCustomEvents?.length) {
      return;
    }

    setCustomNodeEvents((prev) => {
      // If no existing events, set all new events
      if (prev.length === 0) {
        return allCustomEvents;
      }

      // Merge new events with existing ones:
      // - Events with matching actionId should UPDATE (not be filtered out)
      // - This ensures 'success' events properly replace 'pending' events
      const existingActionIds = new Map(prev.map((e, idx) => [e.actionId, idx]));
      let hasUpdates = false;
      const updatedPrev = [...prev];
      const newEvents: CustomNodeEvent[] = [];

      for (const newEvent of allCustomEvents) {
        const existingIdx = existingActionIds.get(newEvent.actionId);
        if (existingIdx !== undefined) {
          // Only update if status actually changed
          if (updatedPrev[existingIdx].data.status !== newEvent.data.status) {
            updatedPrev[existingIdx] = newEvent;
            hasUpdates = true;
          }
        } else {
          newEvents.push(newEvent);
        }
      }

      if (newEvents.length > 0 || hasUpdates) {
        return [...updatedPrev, ...newEvents];
      }

      return prev;
    });
  }, [stream.messages]);

  // Clear streamLoading as soon as we get any content (agent has started running)
  useEffect(() => {
    const hasContent =
      filteredMessages.length > 0 || customNodeEvents.length > 0;

    if (hasContent && streamLoading) {
      setStreamLoading(false);
    }
  }, [stream.messages, customNodeEvents, streamLoading]);

  useEffect(() => {
    if (stream.error) {
      const rawErrorMessage =
        typeof stream.error === "object" && "message" in stream.error
          ? (stream.error.message as string)
          : "An unknown error occurred in the manager";

      if (rawErrorMessage.includes("overloaded_error")) {
        setErrorState({
          message:
            "An Anthropic overloaded error occurred. This error occurs when Anthropic APIs experience high traffic across all users.",
          details: rawErrorMessage,
        });
      } else {
        setErrorState({
          message: rawErrorMessage,
        });
      }
    } else {
      setErrorState(null);
    }
  }, [stream.error]);

  if (streamLoading && !errorState) {
    return <LoadingActionsCardContent />;
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto py-4">
      {initializeEvents.length > 0 && steps.length > 0 && (
        <InitializeStep
          status={initStatus}
          steps={steps}
          success={allSuccess}
        />
      )}
      {filteredMessages?.map((m) => (
        <AssistantMessage
          key={m.id}
          thread={stream as UseStream<Record<string, unknown>>}
          threadMessages={allMessages}
          message={m}
          modifyRunId={modifyRunId}
          threadId={threadId}
          assistantId={stream.assistantId}
          requestHelpEvents={requestHelpEvents}
        />
      ))}
      {acceptedPlanEvents.length > 0 &&
        isAcceptedPlanEvents(acceptedPlanEvents) && (
          <AcceptedPlanStep
            taskPlan={taskPlan}
            planTitle={
              acceptedPlanEvents[acceptedPlanEvents.length - 1].data.planTitle
            }
            planItems={
              acceptedPlanEvents[acceptedPlanEvents.length - 1].data.planItems
            }
            interruptType={
              acceptedPlanEvents[acceptedPlanEvents.length - 1].data
                .interruptType
            }
          />
        )}
      {/* If the last message is hidden, but there's an interrupt, we must manually render the interrupt */}
      {isLastMessageHidden && stream.interrupt ? (
        <Interrupt
          interruptValue={stream.interrupt?.value}
          isLastMessage={true}
          thread={stream as UseStream<Record<string, unknown>>}
        />
      ) : null}
      {errorState ? (
        <CollapsibleAlert
          variant="destructive"
          errorState={errorState}
          icon={<AlertCircle className="size-4" />}
        />
      ) : null}
    </div>
  );
}
