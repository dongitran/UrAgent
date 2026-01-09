import { v4 as uuidv4 } from "uuid";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import {
  GraphConfig,
  GraphState,
  GraphUpdate,
  TaskPlan,
} from "@openswe/shared/open-swe/types";
import { Command } from "@langchain/langgraph";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import {
  completePlanItem,
  getActivePlanItems,
  getActiveTask,
} from "@openswe/shared/open-swe/tasks";
import {
  getCurrentPlanItem,
} from "../../../utils/current-task.js";
import { isAIMessage, ToolMessage } from "@langchain/core/messages";
import { addTaskPlanToIssue } from "../../../utils/github/issue-task.js";
import { createMarkTaskCompletedToolFields } from "@openswe/shared/open-swe/tools";
import {
  calculateConversationHistoryTokenCount,
  getMessagesSinceLastSummary,
  MAX_INTERNAL_TOKENS,
} from "../../../utils/tokens.js";
import { z } from "zod";
import { shouldCreateIssue } from "../../../utils/should-create-issue.js";
import { getSandboxInstanceWithErrorHandling } from "../../../utils/sandbox.js";
import {
  checkoutBranchAndCommitWithInstance,
  getChangedFilesStatusWithInstance,
} from "../../../utils/github/git.js";
import { getGitHubTokensFromConfig } from "../../../utils/github-tokens.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { isRunCancelled } from "../../../utils/run-cancellation.js";
import { END } from "@langchain/langgraph";

const logger = createLogger(LogLevel.INFO, "HandleCompletedTask");

export async function handleCompletedTask(
  state: GraphState,
  config: GraphConfig,
): Promise<Command> {
  if (await isRunCancelled(config)) {
    return new Command({
      goto: END,
    });
  }
  const markCompletedTool = createMarkTaskCompletedToolFields();
  const markCompletedMessage =
    state.internalMessages[state.internalMessages.length - 1];
  if (
    !isAIMessage(markCompletedMessage) ||
    !markCompletedMessage.tool_calls?.length ||
    !markCompletedMessage.tool_calls.some(
      (tc) => tc.name === markCompletedTool.name,
    )
  ) {
    throw new Error("Failed to find a tool call when checking task status.");
  }
  const toolCall = markCompletedMessage.tool_calls?.[0];
  if (!toolCall) {
    throw new Error(
      "Failed to generate a tool call when checking task status.",
    );
  }

  const activePlanItems = getActivePlanItems(state.taskPlan);
  const currentTask = getCurrentPlanItem(activePlanItems);
  const toolMessage = new ToolMessage({
    id: uuidv4(),
    tool_call_id: toolCall.id ?? "",
    content: `Saved task status as completed for task ${currentTask?.plan || "unknown"}`,
    name: toolCall.name,
  });

  const newMessages = [toolMessage];

  const newMessageList = [...state.internalMessages, ...newMessages];
  const wouldBeConversationHistoryToSummarize =
    await getMessagesSinceLastSummary(newMessageList, {
      excludeHiddenMessages: true,
      excludeCountFromEnd: 20,
    });
  const totalInternalTokenCount = calculateConversationHistoryTokenCount(
    wouldBeConversationHistoryToSummarize,
    {
      // Retain the last 20 messages from state
      excludeHiddenMessages: true,
      excludeCountFromEnd: 20,
    },
  );

  const summary = (toolCall.args as z.infer<typeof markCompletedTool.schema>)
    .completed_task_summary;

  // IMPORTANT: Commit any pending changes before marking task as completed
  // This ensures that all code changes made during the task are committed
  let branchName: string | undefined = state.branchName;
  let updatedTaskPlanFromCommit: TaskPlan | undefined;

  if (!isLocalMode(config)) {
    const { sandboxInstance } = await getSandboxInstanceWithErrorHandling(
      state.sandboxSessionId,
      state.targetRepository,
      state.branchName,
      config,
    );

    const repoPath = getRepoAbsolutePath(state.targetRepository, undefined, sandboxInstance.providerType);
    const changedFiles = await getChangedFilesStatusWithInstance(repoPath, sandboxInstance, config);

    logger.info("=== HANDLE COMPLETED TASK - CHECKING FOR COMMITS ===", {
      changedFilesCount: changedFiles.length,
      changedFiles,
      branchName,
      targetBranch: state.targetRepository?.branch,
    });

    if (changedFiles.length > 0) {
      logger.info(
        `Has ${changedFiles.length} changed files before marking task complete. Committing.`,
        {
          changedFiles,
          branchName,
          targetBranch: state.targetRepository?.branch,
        },
      );

      const { githubInstallationToken } =
        await getGitHubTokensFromConfig(config);
      const result = await checkoutBranchAndCommitWithInstance(
        config,
        state.targetRepository,
        sandboxInstance,
        {
          branchName,
          githubInstallationToken,
          taskPlan: state.taskPlan,
          githubIssueId: state.githubIssueId,
        },
      );

      logger.info("After checkoutBranchAndCommit in handle-completed-task", {
        oldBranchName: branchName,
        newBranchName: result.branchName,
        branchChanged: branchName !== result.branchName,
      });

      branchName = result.branchName;
      updatedTaskPlanFromCommit = result.updatedTaskPlan;
    }
  }

  // Use the task plan from commit if available, otherwise use state's task plan
  const taskPlanToUpdate = updatedTaskPlanFromCommit ?? state.taskPlan;

  // Re-calculate currentTask from taskPlanToUpdate to ensure consistency
  // This handles the case where updatedTaskPlanFromCommit has different completion status
  const activePlanItemsToUpdate = getActivePlanItems(taskPlanToUpdate);
  const currentTaskToUpdate = getCurrentPlanItem(activePlanItemsToUpdate);

  // Check if currentTask is valid (index !== -1 means there's an actual uncompleted task)
  // If index === -1, it means all tasks are already completed (fallback from getCurrentPlanItem)
  let updatedPlanTasks: TaskPlan;
  if (currentTaskToUpdate.index === -1) {
    logger.warn("All plan items are already completed, skipping completePlanItem call", {
      currentTaskIndex: currentTaskToUpdate.index,
      currentTaskPlan: currentTaskToUpdate.plan,
      activePlanItemsCount: activePlanItemsToUpdate.length,
      completedCount: activePlanItemsToUpdate.filter(p => p.completed).length,
      originalCurrentTaskIndex: currentTask.index,
    });
    // Use the task plan as-is since there's nothing to mark as completed
    updatedPlanTasks = taskPlanToUpdate;
  } else {
    // LLM marked as completed, so we need to update the plan to reflect that.
    updatedPlanTasks = completePlanItem(
      taskPlanToUpdate,
      getActiveTask(taskPlanToUpdate).id,
      currentTaskToUpdate.index,
      summary,
    );
  }
  // Update the github issue to reflect this task as completed.
  if (
    !isLocalMode(config) &&
    shouldCreateIssue(config) &&
    state.githubIssueId
  ) {
    await addTaskPlanToIssue(
      {
        githubIssueId: state.githubIssueId,
        targetRepository: state.targetRepository,
      },
      config,
      updatedPlanTasks,
    );
  } else {
    logger.info("Skipping GitHub issue update", {
      isLocalMode: isLocalMode(config),
      shouldCreateIssue: shouldCreateIssue(config),
      hasGithubIssueId: !!state.githubIssueId,
    });
  }

  const commandUpdate: GraphUpdate = {
    messages: newMessages,
    internalMessages: newMessages,
    // Even though there are no remaining tasks, still mark as completed so the UI reflects that the task is completed.
    taskPlan: updatedPlanTasks,
    ...(branchName && { branchName }),
  };

  // Calculate if there are any uncompleted tasks left in the plan
  // We use getCurrentPlanItem which finds the first task with completed: false
  // If it returns an item with index -1, it means ALL tasks are completed
  const finalActivePlanItems = getActivePlanItems(updatedPlanTasks);
  const currentTaskAfterUpdate = getCurrentPlanItem(finalActivePlanItems);

  if (currentTaskAfterUpdate.index === -1) {
    logger.info(
      "All tasks in the plan are completed. Continuing to the conclusion generation step.",
    );

    return new Command({
      goto: "route-to-review-or-conclusion",
      update: commandUpdate,
    });
  }

  if (totalInternalTokenCount >= MAX_INTERNAL_TOKENS) {
    logger.info(
      "Internal messages list is at or above the max token limit. Routing to summarize history step.",
      {
        totalInternalTokenCount,
        maxInternalTokenCount: MAX_INTERNAL_TOKENS,
      },
    );

    return new Command({
      goto: "summarize-history",
      update: commandUpdate,
    });
  }

  return new Command({
    goto: "generate-action",
    update: commandUpdate,
  });
}
