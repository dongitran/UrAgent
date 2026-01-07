import { v4 as uuidv4 } from "uuid";
import {
  CustomRules,
  GraphConfig,
  GraphState,
  GraphUpdate,
  PlanItem,
  TaskPlan,
} from "@openswe/shared/open-swe/types";
import {
  checkoutBranchAndCommitWithInstance,
  getChangedFilesStatusWithInstance,
  pushEmptyCommitWithInstance,
} from "../../../utils/github/git.js";
import {
  createPullRequest,
  updatePullRequest,
} from "../../../utils/github/api.js";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { z } from "zod";
import {
  loadModel,
  supportsParallelToolCallsParam,
} from "../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import { formatPlanPromptWithSummaries } from "../../../utils/plan-prompt.js";
import { formatUserRequestPrompt, getInitialUserRequest } from "../../../utils/user-request.js";
import { extractIssueTitleAndBodyFromContent } from "../../../utils/github/issue-messages.js";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import {
  deleteSandbox,
  getSandboxInstanceWithErrorHandling,
} from "../../../utils/sandbox.js";
import { getGitHubTokensFromConfig } from "../../../utils/github-tokens.js";
import {
  getActivePlanItems,
  getPullRequestNumberFromActiveTask,
} from "@openswe/shared/open-swe/tasks";
import { createOpenPrToolFields } from "@openswe/shared/open-swe/tools";
import { trackCachePerformance } from "../../../utils/caching.js";
import { getModelManager } from "../../../utils/llms/model-manager.js";
import {
  GitHubPullRequest,
  GitHubPullRequestList,
  GitHubPullRequestUpdate,
} from "../../../utils/github/types.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { GITHUB_USER_LOGIN_HEADER, TIMEOUT_SEC } from "@openswe/shared/constants";
import { shouldCreateIssue } from "../../../utils/should-create-issue.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { postGitHubIssueComment, generateNaturalComment } from "../../../utils/github/plan.js";
import { createShellExecutor } from "../../../utils/shell-executor/index.js";

const logger = createLogger(LogLevel.INFO, "Open PR");

const openPrSysPrompt = `You are operating as a terminal-based agentic coding assistant built by LangChain. It wraps LLM models to enable natural language interaction with a local codebase. You are expected to be precise, safe, and helpful.

You have just completed all of your tasks, and are now ready to open a pull request.

Here are all of the tasks you completed:
{COMPLETED_TASKS}

{USER_REQUEST_PROMPT}

{CUSTOM_RULES}

Always use proper markdown formatting when generating the pull request contents.

You should not include any mention of an issue to close, unless explicitly requested by the user. The body will automatically include a mention of the issue to close.

With all of this in mind, please use the \`open_pr\` tool to open a pull request.`;

const formatCustomRulesPrompt = (pullRequestFormatting: string): string => {
  return `<custom_formatting_rules>
The user has provided the following custom rules around how to format the contents of the pull request.
IMPORTANT: You must follow these instructions exactly when generating the pull request contents. Do not deviate from them in any way.

${pullRequestFormatting}
</custom_formatting_rules>`;
};

const formatPrompt = (
  taskPlan: PlanItem[],
  messages: BaseMessage[],
  customRules?: CustomRules,
): string => {
  const completedTasks = taskPlan.filter((task) => task.completed);
  const customPrFormattingRules = customRules?.pullRequestFormatting
    ? formatCustomRulesPrompt(customRules.pullRequestFormatting)
    : "";
  return openPrSysPrompt
    .replace("{COMPLETED_TASKS}", formatPlanPromptWithSummaries(completedTasks))
    .replace("{USER_REQUEST_PROMPT}", formatUserRequestPrompt(messages))
    .replace("{CUSTOM_RULES}", customPrFormattingRules);
};

export async function openPullRequest(
  state: GraphState,
  config: GraphConfig,
): Promise<GraphUpdate> {
  logger.info("=== OPEN PR NODE STARTED ===", {
    branchName: state.branchName,
    targetBranch: state.targetRepository?.branch,
    owner: state.targetRepository?.owner,
    repo: state.targetRepository?.repo,
    sandboxSessionId: state.sandboxSessionId,
    isLocalMode: isLocalMode(config),
  });

  const { githubInstallationToken } = await getGitHubTokensFromConfig(config);

  const { sandboxInstance, codebaseTree, dependenciesInstalled, sandboxProviderType } =
    await getSandboxInstanceWithErrorHandling(
      state.sandboxSessionId,
      state.targetRepository,
      state.branchName,
      config,
    );
  const sandboxSessionId = sandboxInstance.id;

  const { owner, repo } = state.targetRepository;

  if (!owner || !repo) {
    logger.error(
      "Failed to open pull request: No target repository found in config.",
    );
    throw new Error(
      "Failed to open pull request: No target repository found in config.",
    );
  }

  const repoPath = getRepoAbsolutePath(state.targetRepository, undefined, sandboxInstance.providerType);

  // First, verify that there are changed files
  logger.info("Checking for changed files...", {
    repoPath,
    baseBranch: state.targetRepository.branch,
  });

  // Use ShellExecutor for retry support on transient errors
  const executor = createShellExecutor(config);
  const baseBranch = state.targetRepository.branch ?? "";
  
  // Git diff with local base branch (always exists because providers clone base branch first)
  const gitDiffRes = await executor.executeCommand({
    command: `git diff --name-only ${baseBranch}`,
    workdir: repoPath,
    timeout: TIMEOUT_SEC,
    sandboxInstance,
  });

  logger.info("Git diff result", {
    exitCode: gitDiffRes.exitCode,
    result: gitDiffRes.result,
    hasChanges: gitDiffRes.result.trim().length > 0,
  });

  if (gitDiffRes.exitCode !== 0 || gitDiffRes.result.trim().length === 0) {
    // no changed files
    logger.warn("No changed files detected, skipping PR creation", {
      exitCode: gitDiffRes.exitCode,
      result: gitDiffRes.result,
      branchName: state.branchName,
      baseBranch: state.targetRepository.branch,
    });
    const sandboxDeleted = await deleteSandbox(sandboxSessionId);
    return {
      ...(sandboxDeleted && {
        sandboxSessionId: undefined,
        dependenciesInstalled: false,
      }),
    };
  }

  let branchName = state.branchName;
  let updatedTaskPlan: TaskPlan | undefined;

  const changedFiles = await getChangedFilesStatusWithInstance(repoPath, sandboxInstance, config);

  logger.info("Changed files status", {
    changedFilesCount: changedFiles.length,
    changedFiles,
    currentBranch: branchName,
    baseBranch: state.targetRepository.branch,
  });

  if (changedFiles.length > 0) {
    logger.info(`Has ${changedFiles.length} changed files. Committing.`, {
      changedFiles,
    });
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
    branchName = result.branchName;
    updatedTaskPlan = result.updatedTaskPlan;

    logger.info("After checkoutBranchAndCommit", {
      newBranchName: branchName,
      hasUpdatedTaskPlan: !!updatedTaskPlan,
    });
  }

  const openPrTool = createOpenPrToolFields();
  // use the router model since this is a simple task that doesn't need an advanced model
  const model = await loadModel(config, LLMTask.ROUTER);
  const modelManager = getModelManager();
  const modelName = modelManager.getModelNameForTask(config, LLMTask.ROUTER);
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.ROUTER,
  );
  const modelWithTool = model.bindTools([openPrTool], {
    tool_choice: openPrTool.name,
    ...(modelSupportsParallelToolCallsParam
      ? {
          parallel_tool_calls: false,
        }
      : {}),
  });

  const response = await modelWithTool.invoke([
    {
      role: "user",
      content: formatPrompt(
        getActivePlanItems(state.taskPlan),
        state.internalMessages,
      ),
    },
  ]);

  const toolCall = response.tool_calls?.[0];

  if (!toolCall) {
    throw new Error(
      "Failed to generate a tool call when opening a pull request.",
    );
  }

  if (process.env.SKIP_CI_UNTIL_LAST_COMMIT === "true") {
    await pushEmptyCommitWithInstance(state.targetRepository, sandboxInstance, config, {
      githubInstallationToken,
    });
  }

  const { title, body } = toolCall.args as z.infer<typeof openPrTool.schema>;

  const userLogin = config.configurable?.[GITHUB_USER_LOGIN_HEADER];

  const prForTask = getPullRequestNumberFromActiveTask(
    updatedTaskPlan ?? state.taskPlan,
  );
  let pullRequest:
    | GitHubPullRequest
    | GitHubPullRequestList[number]
    | GitHubPullRequestUpdate
    | null = null;

  const reviewPullNumber = config.configurable?.reviewPullNumber;
  const prBody = `${shouldCreateIssue(config) ? `Fixes #${state.githubIssueId}` : ""}${reviewPullNumber ? `\n\nTriggered from pull request: #${reviewPullNumber}` : ""}${userLogin ? `\n\nOwner: @${userLogin}` : ""}\n\n${body}`;

  logger.info("=== CREATING/UPDATING PULL REQUEST ===", {
    prForTask,
    headBranch: branchName,
    baseBranch: state.targetRepository.branch,
    owner,
    repo,
    title,
    userLogin,
    reviewPullNumber,
    shouldCreateIssue: shouldCreateIssue(config),
    githubIssueId: state.githubIssueId,
    isSameBranch: branchName === state.targetRepository.branch,
  });

  // CRITICAL: Check if head branch is same as base branch
  if (branchName === state.targetRepository.branch) {
    logger.error(
      "CRITICAL ERROR: Cannot create PR - head branch is same as base branch!",
      {
        headBranch: branchName,
        baseBranch: state.targetRepository.branch,
      },
    );
    throw new Error(
      `Cannot create PR: head branch (${branchName}) is same as base branch (${state.targetRepository.branch})`,
    );
  }

  if (!prForTask) {
    // No PR created yet. Shouldn't be possible, but we have a condition here anyway
    logger.info("Creating new pull request (no existing PR for task)", {
      headBranch: branchName,
      baseBranch: state.targetRepository.branch,
    });

    try {
      pullRequest = await createPullRequest({
        owner,
        repo,
        headBranch: branchName,
        title,
        body: prBody,
        githubInstallationToken,
        baseBranch: state.targetRepository.branch,
      });

      logger.info("Pull request created successfully", {
        prNumber: pullRequest?.number,
        prUrl: pullRequest?.html_url,
      });
    } catch (error) {
      logger.error("Failed to create pull request", {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        headBranch: branchName,
        baseBranch: state.targetRepository.branch,
      });
      throw error;
    }
  } else {
    // Ensure the PR is ready for review
    logger.info("Updating existing pull request", {
      prNumber: prForTask,
    });

    try {
      pullRequest = await updatePullRequest({
        owner,
        repo,
        title,
        body: prBody,
        pullNumber: prForTask,
        githubInstallationToken,
      });

      logger.info("Pull request updated successfully", {
        prNumber: pullRequest?.number,
        prUrl: pullRequest?.html_url,
      });
    } catch (error) {
      logger.error("Failed to update pull request", {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        prNumber: prForTask,
      });
      throw error;
    }
  }

  let sandboxDeleted = false;
  if (pullRequest) {
    // Delete the sandbox.
    sandboxDeleted = await deleteSandbox(sandboxSessionId);

    // Post comment to GitHub issue about PR creation/update (only if not in local mode and has githubIssueId)
    if (!isLocalMode(config) && state.githubIssueId) {
      const prAction = prForTask ? "updated" : "created";
      const completedTasksCount = getActivePlanItems(state.taskPlan).filter(t => t.completed).length;
      const totalTasksCount = getActivePlanItems(state.taskPlan).length;
      
      // Get issue content for language detection
      const issueContent = getInitialUserRequest(state.internalMessages);
      const { issueTitle, issueBody } = extractIssueTitleAndBodyFromContent(issueContent);
      
      logger.warn("[OpenPR] Issue content for language detection", {
        issueContentLength: issueContent?.length || 0,
        issueContentSnippet: issueContent?.slice(0, 200),
        extractedTitle: issueTitle,
        extractedBodyLength: issueBody?.length || 0,
        extractedBodySnippet: issueBody?.slice(0, 100),
      });
      
      const completionMessage = await generateNaturalComment({
        type: "implementation_complete",
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
        prTitle: title,
        prAction,
        tasksCompleted: completedTasksCount,
        totalTasks: totalTasksCount,
        issueTitle,
        issueBody,
      });
      
      await postGitHubIssueComment({
        githubIssueId: state.githubIssueId,
        targetRepository: state.targetRepository,
        commentBody: completionMessage,
        config,
      });

      logger.info("Posted completion comment to GitHub issue", {
        githubIssueId: state.githubIssueId,
        prNumber: pullRequest.number,
        prAction,
      });
    }
  }

  const newMessages = [
    new AIMessage({
      ...response,
      additional_kwargs: {
        ...response.additional_kwargs,
        // Required for the UI to render these fields.
        branch: branchName,
        targetBranch: state.targetRepository.branch,
      },
    }),
    new ToolMessage({
      id: uuidv4(),
      tool_call_id: toolCall.id ?? "",
      content: pullRequest
        ? `Marked pull request as ready for review: ${pullRequest.html_url}`
        : "Failed to mark pull request as ready for review.",
      name: toolCall.name,
      additional_kwargs: {
        pull_request: pullRequest,
      },
    }),
  ];

  return {
    messages: newMessages,
    internalMessages: newMessages,
    // If the sandbox was successfully deleted, we can remove it from the state & reset the dependencies installed flag.
    ...(sandboxDeleted && {
      sandboxSessionId: undefined,
      dependenciesInstalled: false,
    }),
    ...(sandboxProviderType && { sandboxProviderType }),
    ...(codebaseTree && { codebaseTree }),
    ...(dependenciesInstalled !== null && { dependenciesInstalled }),
    tokenData: trackCachePerformance(response, modelName),
    ...(updatedTaskPlan && { taskPlan: updatedTaskPlan }),
  };
}
