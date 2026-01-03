import { Sandbox } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "../logger.js";
import {
  GraphConfig,
  TargetRepository,
  TaskPlan,
} from "@openswe/shared/open-swe/types";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import { getSandboxErrorFields } from "../sandbox-error-fields.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { ExecuteResponse } from "@daytonaio/sdk/src/types/ExecuteResponse.js";
import { withRetry } from "../retry.js";
import {
  addPullRequestNumberToActiveTask,
  getActiveTask,
  getPullRequestNumberFromActiveTask,
} from "@openswe/shared/open-swe/tasks";
import { createPullRequest, getBranch } from "./api.js";
import { addTaskPlanToIssue } from "./issue-task.js";
import { DEFAULT_EXCLUDED_PATTERNS } from "./constants.js";
import { escapeRegExp } from "../string-utils.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { createShellExecutor } from "../shell-executor/index.js";
import { shouldCreateIssue } from "../should-create-issue.js";

const logger = createLogger(LogLevel.INFO, "GitHub-Git");

// Retry configuration for direct sandbox commands
const SANDBOX_MAX_RETRIES = 5;
const SANDBOX_RETRY_DELAY_MS = 10000; // 10 seconds, exponential: 10s → 20s → 40s → 80s → 160s

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (network, timeout, gateway errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();
    
    if (message.includes('timeout') || 
        message.includes('network') || 
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('socket') ||
        message.includes('fetch failed') ||
        message.includes('502') || 
        message.includes('503') || 
        message.includes('504') ||
        message.includes('gateway') ||
        message.includes('cloudfront') ||
        name.includes('timeout') ||
        name.includes('abort')) {
      return true;
    }
  }
  return false;
}

/**
 * Execute sandbox command with retry logic for transient errors
 */
async function executeSandboxCommandWithRetry(
  sandbox: Sandbox,
  command: string,
  workdir: string,
  timeout: number,
): Promise<{ exitCode: number; result: string }> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < SANDBOX_MAX_RETRIES; attempt++) {
    try {
      const response = await sandbox.process.executeCommand(
        command,
        workdir,
        undefined,
        timeout,
      );
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (isRetryableError(error) && attempt < SANDBOX_MAX_RETRIES - 1) {
        const delay = SANDBOX_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn("[DAYTONA] Command failed, retrying...", {
          sandboxId: sandbox.id,
          command: command.substring(0, 100),
          attempt: attempt + 1,
          maxRetries: SANDBOX_MAX_RETRIES,
          retryDelayMs: delay,
          error: lastError.message,
        });
        await sleep(delay);
        continue;
      }
      
      throw error;
    }
  }

  throw lastError ?? new Error("Unknown error in executeSandboxCommandWithRetry");
}

/**
 * Parses git status output and returns an array of file paths.
 * Removes the git status indicators (first 3 characters) from each line.
 */
export function parseGitStatusOutput(gitStatusOutput: string): string[] {
  return gitStatusOutput
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.substring(3))
    .filter(Boolean);
}

/**
 * Validates and filters files before git add operation.
 * Excludes files/directories that should not be committed.
 */
async function getValidFilesToCommit(
  absoluteRepoDir: string,
  sandbox: Sandbox,
  config: GraphConfig,
  excludePatterns: string[] = DEFAULT_EXCLUDED_PATTERNS,
): Promise<string[]> {
  // Use unified shell executor
  const executor = createShellExecutor(config);
  const gitStatusOutput = await executor.executeCommand({
    command: "git status --porcelain",
    workdir: absoluteRepoDir,
    timeout: TIMEOUT_SEC,
    sandbox,
  });

  if (gitStatusOutput.exitCode !== 0) {
    logger.error(`Failed to get git status for file validation`, {
      gitStatusOutput,
    });
    throw new Error("Failed to get git status for file validation");
  }

  const allFiles = parseGitStatusOutput(gitStatusOutput.result);

  const validFiles = allFiles.filter((filePath) => {
    return !shouldExcludeFile(filePath, excludePatterns);
  });

  const excludedFiles = allFiles.filter((filePath) => {
    return shouldExcludeFile(filePath, excludePatterns);
  });

  if (excludedFiles.length > 0) {
    logger.info(`Excluded ${excludedFiles.length} files from commit:`, {
      excludedFiles: excludedFiles,
    });
  }

  return validFiles;
}

/**
 * Checks if a file should be excluded from commits based on patterns.
 */
export function shouldExcludeFile(
  filePath: string,
  excludePatterns: string[],
): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");

  return excludePatterns.some((pattern) => {
    if (pattern.includes("*")) {
      const escapedPattern = escapeRegExp(pattern);
      const regexPattern = escapedPattern.replace(/\\\*/g, ".*");
      const regex = new RegExp(
        `^${regexPattern}$|/${regexPattern}$|^${regexPattern}/|/${regexPattern}/`,
      );
      return regex.test(normalizedPath);
    }

    return (
      normalizedPath === pattern ||
      normalizedPath.startsWith(pattern + "/") ||
      normalizedPath.includes("/" + pattern + "/") ||
      normalizedPath.endsWith("/" + pattern)
    );
  });
}

export function getBranchName(configOrThreadId: GraphConfig | string): string {
  const threadId =
    typeof configOrThreadId === "string"
      ? configOrThreadId
      : configOrThreadId.configurable?.thread_id;
  if (!threadId) {
    throw new Error("No thread ID provided");
  }

  const branchName = `open-swe/${threadId}`;
  logger.info("Generated branch name from thread ID", {
    threadId,
    branchName,
  });
  return branchName;
}

export async function getChangedFilesStatus(
  absoluteRepoDir: string,
  sandbox: Sandbox,
  config: GraphConfig,
): Promise<string[]> {
  // Use unified shell executor
  const executor = createShellExecutor(config);
  const gitStatusOutput = await executor.executeCommand({
    command: "git status --porcelain",
    workdir: absoluteRepoDir,
    timeout: TIMEOUT_SEC,
    sandbox,
  });

  if (gitStatusOutput.exitCode !== 0) {
    logger.error(`Failed to get changed files status`, {
      gitStatusOutput,
    });
    return [];
  }

  return parseGitStatusOutput(gitStatusOutput.result);
}

export async function stashAndClearChanges(
  absoluteRepoDir: string,
  sandbox: Sandbox | null,
  config?: GraphConfig,
): Promise<ExecuteResponse | false> {
  // In local mode, we don't want to stash and clear changes
  if (config && isLocalMode(config)) {
    logger.info("Skipping stash and clear changes in local mode");
    return {
      exitCode: 0,
      result: "Skipped stash and clear in local mode",
    };
  }

  try {
    // Use unified shell executor
    const executor = createShellExecutor(config);

    // First, try to remove any nested git directories that might cause issues
    // These can be created by tools like nest new, create-react-app, etc.
    // The error "does not have a commit checked out" happens when git add tries to add a nested repo
    const cleanNestedGitOutput = await executor.executeCommand({
      command:
        "find . -mindepth 2 -name '.git' -type d -exec rm -rf {} + 2>/dev/null || true",
      workdir: absoluteRepoDir,
      timeout: TIMEOUT_SEC,
      sandbox: sandbox || undefined,
    });

    if (cleanNestedGitOutput.exitCode !== 0) {
      logger.warn("Failed to clean nested git directories (non-fatal)", {
        cleanNestedGitOutput,
      });
    }

    // Now try the standard stash and clear
    const gitStashOutput = await executor.executeCommand({
      command: "git add -A && git stash && git reset --hard",
      workdir: absoluteRepoDir,
      timeout: TIMEOUT_SEC,
      sandbox: sandbox || undefined,
    });

    if (gitStashOutput.exitCode !== 0) {
      // If standard approach fails, try alternative: git clean + git checkout
      logger.warn("Standard stash failed, trying alternative cleanup", {
        gitStashOutput,
      });

      const alternativeCleanup = await executor.executeCommand({
        command: "git checkout -- . && git clean -fd",
        workdir: absoluteRepoDir,
        timeout: TIMEOUT_SEC,
        sandbox: sandbox || undefined,
      });

      if (alternativeCleanup.exitCode !== 0) {
        logger.error("Alternative cleanup also failed", {
          alternativeCleanup,
        });
        return alternativeCleanup;
      }

      return alternativeCleanup;
    }
    return gitStashOutput;
  } catch (e) {
    // Unified error handling
    const errorFields = getSandboxErrorFields(e);
    logger.error(`Failed to stash and clear changes`, {
      ...(errorFields && { errorFields }),
      ...(e instanceof Error && {
        name: e.name,
        message: e.message,
        stack: e.stack,
      }),
    });
    return errorFields ?? false;
  }
}

function constructCommitMessage(): string {
  const baseCommitMessage = "Apply patch";
  const skipCiString = "[skip ci]";
  const vercelSkipCi = process.env.SKIP_CI_UNTIL_LAST_COMMIT === "true";
  if (vercelSkipCi) {
    return `${baseCommitMessage} ${skipCiString}`;
  }
  return baseCommitMessage;
}

export async function checkoutBranchAndCommit(
  config: GraphConfig,
  targetRepository: TargetRepository,
  sandbox: Sandbox,
  options: {
    branchName?: string;
    githubInstallationToken: string;
    taskPlan: TaskPlan;
    githubIssueId: number;
  },
): Promise<{ branchName: string; updatedTaskPlan?: TaskPlan }> {
  const absoluteRepoDir = getRepoAbsolutePath(targetRepository);
  const branchName = options.branchName || getBranchName(config);

  logger.info("=== CHECKOUT BRANCH AND COMMIT STARTED ===", {
    optionsBranchName: options.branchName,
    generatedBranchName: getBranchName(config),
    finalBranchName: branchName,
    baseBranch: targetRepository.branch,
    isFeatureBranch: branchName !== targetRepository.branch,
    absoluteRepoDir,
  });

  // IMPORTANT: Prevent committing directly to base branch
  if (branchName === targetRepository.branch) {
    logger.warn(
      "⚠️ WARNING: Attempting to commit to base branch! Creating feature branch instead.",
      {
        baseBranch: targetRepository.branch,
        branchName,
        threadId: config.configurable?.thread_id,
      },
    );
    // Force create a new feature branch
    const featureBranchName = getBranchName(config);
    logger.info(`Creating feature branch instead: ${featureBranchName}`, {
      oldBranchName: branchName,
      newBranchName: featureBranchName,
    });
    return checkoutBranchAndCommit(config, targetRepository, sandbox, {
      ...options,
      branchName: featureBranchName,
    });
  }

  logger.info(`✅ Branch is valid feature branch, proceeding with commit`, {
    branchName,
    baseBranch: targetRepository.branch,
  });

  // Validate and filter files before committing
  const validFiles = await getValidFilesToCommit(
    absoluteRepoDir,
    sandbox,
    config,
  );

  if (validFiles.length === 0) {
    logger.info("No valid files to commit after filtering");
    return { branchName, updatedTaskPlan: options.taskPlan };
  }

  // Add only validated files instead of adding all files with "."
  await sandbox.git.add(absoluteRepoDir, validFiles);

  const botAppName = process.env.GITHUB_APP_NAME;
  if (!botAppName) {
    logger.error("GITHUB_APP_NAME environment variable is not set.");
    throw new Error("GITHUB_APP_NAME environment variable is not set.");
  }
  const userName = `${botAppName}[bot]`;
  const userEmail = `${botAppName}@users.noreply.github.com`;
  await sandbox.git.commit(
    absoluteRepoDir,
    constructCommitMessage(),
    userName,
    userEmail,
  );

  // Push the changes using the git API so it handles authentication for us.
  const pushRes = await withRetry(
    async () => {
      return await sandbox.git.push(
        absoluteRepoDir,
        "git",
        options.githubInstallationToken,
      );
    },
    { retries: 3, delay: 0 },
  );

  if (pushRes instanceof Error) {
    const errorFields =
      pushRes instanceof Error
        ? {
            message: pushRes.message,
            name: pushRes.name,
          }
        : pushRes;

    logger.error("Failed to push changes, attempting to pull and push again", {
      ...errorFields,
    });

    // attempt to git pull, then push again
    const pullRes = await withRetry(
      async () => {
        return await sandbox.git.pull(
          absoluteRepoDir,
          "git",
          options.githubInstallationToken,
        );
      },
      { retries: 1, delay: 0 },
    );

    if (pullRes instanceof Error) {
      const errorFields =
        pullRes instanceof Error
          ? {
              message: pullRes.message,
              name: pullRes.name,
            }
          : pullRes;
      logger.error("Failed to pull changes after a push failed.", {
        ...errorFields,
      });
    } else {
      logger.info("Successfully pulled changes. Pushing again.");
    }

    const pushRes2 = await withRetry(
      async () => {
        return await sandbox.git.push(
          absoluteRepoDir,
          "git",
          options.githubInstallationToken,
        );
      },
      { retries: 3, delay: 0 },
    );

    if (pushRes2 instanceof Error) {
      const gitStatus = await sandbox.git.status(absoluteRepoDir);
      const errorFields = {
        ...(pushRes2 instanceof Error
          ? {
              name: pushRes2.name,
              message: pushRes2.message,
              stack: pushRes2.stack,
              cause: pushRes2.cause,
            }
          : pushRes2),
      };
      logger.error("Failed to push changes", {
        ...errorFields,
        gitStatus: JSON.stringify(gitStatus, null, 2),
      });
      throw new Error("Failed to push changes");
    } else {
      logger.info("Pulling changes before pushing succeeded");
    }
  } else {
    logger.info("Successfully pushed changes");
  }

  // Check if the active task has a PR associated with it. If not, create a draft PR.
  let updatedTaskPlan: TaskPlan | undefined;
  const activeTask = getActiveTask(options.taskPlan);
  const prForTask = getPullRequestNumberFromActiveTask(options.taskPlan);

  logger.info("Checking if draft PR needs to be created", {
    hasActiveTask: !!activeTask,
    activeTaskTitle: activeTask?.title,
    prForTask,
    branchName,
    baseBranch: targetRepository.branch,
  });

  if (!prForTask) {
    logger.info("First commit detected, creating a draft pull request.", {
      branchName,
      baseBranch: targetRepository.branch,
      activeTaskTitle: activeTask?.title,
    });
    const hasIssue = shouldCreateIssue(config);

    const reviewPullNumber = config.configurable?.reviewPullNumber;

    const pullRequest = await createPullRequest({
      owner: targetRepository.owner,
      repo: targetRepository.repo,
      headBranch: branchName,
      title: `[WIP]: ${activeTask?.title ?? "Open SWE task"}`,
      body: `**WORK IN PROGRESS OPEN SWE PR**${hasIssue ? `\n\nFixes: #${options.githubIssueId}` : ""}${reviewPullNumber ? `\n\nTriggered from pull request: #${reviewPullNumber}` : ""}`,
      githubInstallationToken: options.githubInstallationToken,
      draft: true,
      baseBranch: targetRepository.branch,
      nullOnError: true,
    });

    if (pullRequest) {
      logger.info(`✅ Draft pull request created successfully!`, {
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
        branchName,
        baseBranch: targetRepository.branch,
      });
      updatedTaskPlan = addPullRequestNumberToActiveTask(
        options.taskPlan,
        pullRequest.number,
      );
      if (hasIssue) {
        await addTaskPlanToIssue(
          {
            githubIssueId: options.githubIssueId,
            targetRepository,
          },
          config,
          updatedTaskPlan,
        );
        logger.info(
          `Draft pull request linked to issue: #${options.githubIssueId}`,
        );
      }
    } else {
      logger.warn("Failed to create draft pull request", {
        branchName,
        baseBranch: targetRepository.branch,
      });
    }
  } else {
    logger.info("PR already exists for this task, skipping draft PR creation", {
      prForTask,
      branchName,
    });
  }

  logger.info("Successfully checked out & committed changes.", {
    commitAuthor: userName,
  });

  return { branchName, updatedTaskPlan };
}

export async function pushEmptyCommit(
  targetRepository: TargetRepository,
  sandbox: Sandbox,
  config: GraphConfig,
  options: {
    githubInstallationToken: string;
  },
) {
  const botAppName = process.env.GITHUB_APP_NAME;
  if (!botAppName) {
    logger.error("GITHUB_APP_NAME environment variable is not set.");
    throw new Error("GITHUB_APP_NAME environment variable is not set.");
  }
  const userName = `${botAppName}[bot]`;
  const userEmail = `${botAppName}@users.noreply.github.com`;

  try {
    const absoluteRepoDir = getRepoAbsolutePath(targetRepository);
    const executor = createShellExecutor(config);
    const setGitConfigRes = await executor.executeCommand({
      command: `git config user.name "${userName}" && git config user.email "${userEmail}"`,
      workdir: absoluteRepoDir,
      timeout: TIMEOUT_SEC,
    });
    if (setGitConfigRes.exitCode !== 0) {
      logger.error(`Failed to set git config`, {
        exitCode: setGitConfigRes.exitCode,
        result: setGitConfigRes.result,
      });
      return;
    }

    const emptyCommitRes = await executor.executeCommand({
      command: "git commit --allow-empty -m 'Empty commit to trigger CI'",
      workdir: absoluteRepoDir,
      timeout: TIMEOUT_SEC,
    });
    if (emptyCommitRes.exitCode !== 0) {
      logger.error(`Failed to push empty commit`, {
        exitCode: emptyCommitRes.exitCode,
        result: emptyCommitRes.result,
      });
      return;
    }

    await sandbox.git.push(
      absoluteRepoDir,
      "git",
      options.githubInstallationToken,
    );

    logger.info("Successfully pushed empty commit");
  } catch (e) {
    const errorFields = getSandboxErrorFields(e);
    logger.error(`Failed to push empty commit`, {
      ...(errorFields && { errorFields }),
      ...(e instanceof Error && {
        name: e.name,
        message: e.message,
        stack: e.stack,
      }),
    });
  }
}

export async function pullLatestChanges(
  absoluteRepoDir: string,
  sandbox: Sandbox,
  args: {
    githubInstallationToken: string;
  },
): Promise<boolean> {
  try {
    await sandbox.git.pull(
      absoluteRepoDir,
      "git",
      args.githubInstallationToken,
    );
    return true;
  } catch (e) {
    const errorFields = getSandboxErrorFields(e);
    logger.error(`Failed to pull latest changes`, {
      ...(errorFields && { errorFields }),
      ...(e instanceof Error && {
        name: e.name,
        message: e.message,
        stack: e.stack,
      }),
    });
    return false;
  }
}

/**
 * Securely clones a GitHub repository using temporary credential helper.
 * The GitHub installation token is never persisted in the Git configuration or remote URLs.
 */
export async function cloneRepo(
  sandbox: Sandbox,
  targetRepository: TargetRepository,
  args: {
    githubInstallationToken: string;
    stateBranchName?: string;
  },
): Promise<string> {
  const absoluteRepoDir = getRepoAbsolutePath(targetRepository);
  const cloneUrl = `https://github.com/${targetRepository.owner}/${targetRepository.repo}.git`;
  const branchName = args.stateBranchName || targetRepository.branch;

  logger.debug("[DAYTONA] cloneRepo called", {
    sandboxId: sandbox.id,
    sandboxState: sandbox.state,
    targetRepository: `${targetRepository.owner}/${targetRepository.repo}`,
    branchName,
    absoluteRepoDir,
  });

  try {
    // Attempt to clone the repository
    return await performClone(sandbox, cloneUrl, {
      branchName,
      targetRepository,
      absoluteRepoDir,
      githubInstallationToken: args.githubInstallationToken,
    });
  } catch (error) {
    const errorFields = getSandboxErrorFields(error);
    logger.error("[DAYTONA] Clone repo failed", {
      sandboxId: sandbox.id,
      sandboxState: sandbox.state,
      ...(errorFields ?? { error }),
    });
    throw error;
  }
}

/**
 * Performs the actual Git clone operation, handling branch-specific logic.
 * Returns the branch name that was cloned.
 */
async function performClone(
  sandbox: Sandbox,
  cloneUrl: string,
  args: {
    branchName: string | undefined;
    targetRepository: TargetRepository;
    absoluteRepoDir: string;
    githubInstallationToken: string;
  },
): Promise<string> {
  const {
    branchName,
    targetRepository,
    absoluteRepoDir,
    githubInstallationToken,
  } = args;
  logger.info("[DAYTONA] Cloning repository", {
    sandboxId: sandbox.id,
    sandboxState: sandbox.state,
    repoPath: `${targetRepository.owner}/${targetRepository.repo}`,
    branch: branchName,
    baseCommit: targetRepository.baseCommit,
    absoluteRepoDir,
  });

  if (!branchName && !targetRepository.baseCommit) {
    throw new Error(
      "Can not create new branch or checkout existing branch without branch name",
    );
  }

  const branchExists = branchName
    ? !!(await getBranch({
        owner: targetRepository.owner,
        repo: targetRepository.repo,
        branchName,
        githubInstallationToken,
      }))
    : false;

  if (branchExists) {
    logger.info(
      "[DAYTONA] Branch already exists on remote. Cloning existing branch.",
      {
        sandboxId: sandbox.id,
        branch: branchName,
      },
    );
  }

  logger.debug("[DAYTONA] Calling sandbox.git.clone", {
    sandboxId: sandbox.id,
    cloneUrl: cloneUrl.replace(/\/\/.*@/, "//***@"), // mask token if present
    absoluteRepoDir,
    branch: branchExists ? branchName : targetRepository.branch,
    baseCommit: branchExists ? undefined : targetRepository.baseCommit,
  });

  const cloneStartTime = Date.now();
  await sandbox.git.clone(
    cloneUrl,
    absoluteRepoDir,
    branchExists ? branchName : targetRepository.branch,
    branchExists ? undefined : targetRepository.baseCommit,
    "git",
    githubInstallationToken,
  );

  logger.info("[DAYTONA] Successfully cloned repository", {
    sandboxId: sandbox.id,
    repoPath: `${targetRepository.owner}/${targetRepository.repo}`,
    branch: branchName,
    baseCommit: targetRepository.baseCommit,
    durationMs: Date.now() - cloneStartTime,
  });

  if (targetRepository.baseCommit) {
    return targetRepository.baseCommit;
  }

  if (!branchName) {
    throw new Error("Branch name is required");
  }

  if (branchExists) {
    return branchName;
  }

  try {
    logger.info("[DAYTONA] Creating branch", {
      sandboxId: sandbox.id,
      branch: branchName,
    });

    const createBranchStartTime = Date.now();
    await sandbox.git.createBranch(absoluteRepoDir, branchName);

    logger.info("[DAYTONA] Created branch", {
      sandboxId: sandbox.id,
      branch: branchName,
      durationMs: Date.now() - createBranchStartTime,
    });
  } catch (error) {
    logger.error("[DAYTONA] Failed to create branch, checking out branch", {
      sandboxId: sandbox.id,
      branch: branchName,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
    });
  }

  try {
    // push an empty commit so that the branch exists in the remote
    logger.info("[DAYTONA] Pushing empty commit to remote", {
      sandboxId: sandbox.id,
      branch: branchName,
    });

    const pushStartTime = Date.now();
    await sandbox.git.push(absoluteRepoDir, "git", githubInstallationToken);

    logger.info("[DAYTONA] Pushed empty commit to remote", {
      sandboxId: sandbox.id,
      branch: branchName,
      durationMs: Date.now() - pushStartTime,
    });
  } catch (error) {
    logger.error("[DAYTONA] Failed to push an empty commit to branch", {
      sandboxId: sandbox.id,
      branch: branchName,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
    });
  }

  return branchName;
}

export interface CheckoutFilesOptions {
  sandbox: Sandbox;
  repoDir: string;
  commitSha: string;
  filePaths: string[];
}

/**
 * Checkout specific files from a given commit
 */
export async function checkoutFilesFromCommit(
  options: CheckoutFilesOptions,
): Promise<void> {
  const { sandbox, repoDir, commitSha, filePaths } = options;

  if (filePaths.length === 0) {
    return;
  }

  logger.info(
    `[DAYTONA] Checking out ${filePaths.length} files from commit ${commitSha}`,
    { sandboxId: sandbox.id },
  );

  for (const filePath of filePaths) {
    try {
      const command = `git checkout --force ${commitSha} -- "${filePath}"`;
      logger.debug("[DAYTONA] Executing git checkout for file", {
        sandboxId: sandbox.id,
        command,
        repoDir,
      });

      const startTime = Date.now();
      const result = await executeSandboxCommandWithRetry(
        sandbox,
        command,
        repoDir,
        30,
      );

      logger.debug("[DAYTONA] Git checkout file response", {
        sandboxId: sandbox.id,
        filePath,
        durationMs: Date.now() - startTime,
        exitCode: result.exitCode,
        result: result.result?.substring(0, 300),
      });

      if (result.exitCode !== 0) {
        logger.warn(
          `[DAYTONA] Failed to checkout file ${filePath} from commit ${commitSha}: ${result.result || "Unknown error"}`,
          { sandboxId: sandbox.id },
        );
      } else {
        logger.info(
          `[DAYTONA] Successfully checked out ${filePath} from commit ${commitSha}`,
          { sandboxId: sandbox.id },
        );
      }
    } catch (error) {
      logger.warn(`[DAYTONA] Error checking out file ${filePath}:`, {
        sandboxId: sandbox.id,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : error,
      });
    }
  }
}
