import { Octokit } from "@octokit/rest";
import { createLogger, LogLevel } from "../logger.js";
import {
  GitHubBranch,
  GitHubIssue,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestList,
  GitHubPullRequestUpdate,
  GitHubReviewComment,
} from "./types.js";
import { getOpenSWELabel } from "./label.js";
import { getInstallationToken } from "@openswe/shared/github/auth";
import { getConfig } from "@langchain/langgraph";
import { GITHUB_INSTALLATION_ID } from "@openswe/shared/constants";
import { updateConfig } from "../update-config.js";
import { encryptSecret } from "@openswe/shared/crypto";

const logger = createLogger(LogLevel.INFO, "GitHub-API");

async function getInstallationTokenAndUpdateConfig() {
  try {
    logger.info("Fetching a new GitHub installation token.");
    const config = getConfig();
    const encryptionSecret = process.env.SECRETS_ENCRYPTION_KEY;
    if (!encryptionSecret) {
      throw new Error("Secrets encryption key not found");
    }

    const installationId = config.configurable?.[GITHUB_INSTALLATION_ID];
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!installationId || !appId || !privateKey) {
      throw new Error(
        "GitHub installation ID, app ID, or private key not found",
      );
    }

    const token = await getInstallationToken(installationId, appId, privateKey);
    const encryptedToken = encryptSecret(token, encryptionSecret);
    updateConfig(GITHUB_INSTALLATION_ID, encryptedToken);
    logger.info("Successfully fetched a new GitHub installation token.");
    return token;
  } catch (e) {
    logger.error("Failed to get installation token and update config", {
      error: e,
    });
    return null;
  }
}

/**
 * Check if an error is a transient network error that should be retried
 */
function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;

    // DNS resolution errors
    if (errorCode === "EAI_AGAIN" || message.includes("eai_again")) {
      return true;
    }

    // Connection timeout errors
    if (
      errorCode === "UND_ERR_CONNECT_TIMEOUT" ||
      message.includes("connect timeout") ||
      message.includes("connecttimeouterror")
    ) {
      return true;
    }

    // Other transient errors
    if (
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("socket hang up") ||
      message.includes("network") ||
      message.includes("fetch failed")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number): number {
  const baseDelay = 1000; // 1 second
  const maxDelay = 10000; // 10 seconds
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  // Add jitter (±25%)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Execute an Octokit operation with retry for transient network errors
 * This is a simpler version that doesn't handle token refresh (for operations that don't need it)
 */
async function withNetworkRetry<T>(
  operation: () => Promise<T>,
  errorMessage: string,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isTransientNetworkError(error) && attempt < maxRetries - 1) {
        const delay = calculateRetryDelay(attempt);
        logger.warn(
          `${errorMessage} - transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`,
          { error: lastError.message },
        );
        await sleep(delay);
        continue;
      }

      // Not retryable or max retries reached
      throw lastError;
    }
  }

  throw lastError || new Error("Max retries reached");
}

/**
 * Generic utility for handling GitHub API calls with automatic retry
 * Retries on:
 * - 401 errors (authentication) - refreshes token and retries
 * - Transient network errors (DNS, timeout, connection reset, etc.)
 * 
 * @param options.skipLogOn404 - If true, don't log error for 404 responses (useful for checking if resource exists)
 */
async function withGitHubRetry<T>(
  operation: (token: string) => Promise<T>,
  initialToken: string,
  errorMessage: string,
  additionalLogFields?: Record<string, any>,
  numRetries = 1,
  maxRetries = 3,
  options?: { skipLogOn404?: boolean },
): Promise<T | null> {
  try {
    return await operation(initialToken);
  } catch (error) {
    const errorFields =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : {};

    // Retry on 401 (authentication error) - refresh token
    if (errorFields && errorFields.message?.includes("401") && numRetries < 2) {
      logger.warn(`GitHub API 401 error, refreshing token and retrying...`, {
        attempt: numRetries,
        ...additionalLogFields,
      });
      const token = await getInstallationTokenAndUpdateConfig();
      if (!token) {
        return null;
      }
      return withGitHubRetry(
        operation,
        token,
        errorMessage,
        additionalLogFields,
        numRetries + 1,
        maxRetries,
        options,
      );
    }

    // Retry on transient network errors
    if (isTransientNetworkError(error) && numRetries < maxRetries) {
      const delay = calculateRetryDelay(numRetries - 1);
      logger.warn(
        `GitHub API transient error, retrying in ${delay}ms (attempt ${numRetries}/${maxRetries})`,
        {
          error: errorFields.message,
          ...additionalLogFields,
        },
      );
      await sleep(delay);
      return withGitHubRetry(
        operation,
        initialToken,
        errorMessage,
        additionalLogFields,
        numRetries + 1,
        maxRetries,
        options,
      );
    }

    // Skip logging for 404 errors if option is set (e.g., checking if branch exists)
    const is404Error = errorFields.message?.includes("404") || errorFields.message?.includes("Not Found");
    if (options?.skipLogOn404 && is404Error) {
      return null;
    }

    logger.error(errorMessage, {
      numRetries,
      ...additionalLogFields,
      ...(errorFields ?? { error }),
    });
    return null;
  }
}

async function getExistingPullRequest(
  owner: string,
  repo: string,
  branchName: string,
  githubToken: string,
  numRetries = 1,
): Promise<GitHubPullRequestList[number] | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: pullRequests } = await octokit.pulls.list({
        owner,
        repo,
        head: branchName,
      });

      return pullRequests?.[0] || null;
    },
    githubToken,
    "Failed to get existing pull request",
    { branch: branchName, owner, repo },
    numRetries,
  );
}

export async function createPullRequest({
  owner,
  repo,
  headBranch,
  title,
  body = "",
  githubInstallationToken,
  baseBranch,
  draft = false,
  nullOnError = false,
}: {
  owner: string;
  repo: string;
  headBranch: string;
  title: string;
  body?: string;
  githubInstallationToken: string;
  baseBranch?: string;
  draft?: boolean;
  nullOnError?: boolean;
}): Promise<GitHubPullRequest | GitHubPullRequestList[number] | null> {
  logger.info("=== CREATE PULL REQUEST CALLED ===", {
    owner,
    repo,
    headBranch,
    baseBranch,
    draft,
    nullOnError,
    title,
    isSameBranch: headBranch === baseBranch,
  });

  // CRITICAL: Prevent creating PR with same head and base branch
  if (headBranch === baseBranch) {
    const errorMsg = `Cannot create PR: head branch (${headBranch}) is same as base branch (${baseBranch})`;
    logger.error("CRITICAL ERROR: " + errorMsg);
    throw new Error(errorMsg);
  }

  const octokit = new Octokit({
    auth: githubInstallationToken,
  });

  let repoBaseBranch = baseBranch;
  if (!repoBaseBranch) {
    try {
      logger.info("Fetching default branch from repo", {
        owner,
        repo,
      });
      const { data: repository } = await withNetworkRetry(
        () => octokit.repos.get({ owner, repo }),
        "Failed to fetch repo info",
      );

      repoBaseBranch = repository.default_branch;
      if (!repoBaseBranch) {
        throw new Error("No base branch returned after fetching repo");
      }
      logger.info("Fetched default branch from repo", {
        owner,
        repo,
        baseBranch: repoBaseBranch,
      });
    } catch (e) {
      logger.error("Failed to fetch base branch from repo", {
        owner,
        repo,
        ...(e instanceof Error && {
          name: e.name,
          message: e.message,
          stack: e.stack,
        }),
      });
      return null;
    }
  }

  // Double check after fetching default branch
  if (headBranch === repoBaseBranch) {
    const errorMsg = `Cannot create PR: head branch (${headBranch}) is same as base branch (${repoBaseBranch})`;
    logger.error("CRITICAL ERROR after fetching default branch: " + errorMsg);
    throw new Error(errorMsg);
  }

  let pullRequest: GitHubPullRequest | null = null;
  try {
    logger.info(`Creating pull request: ${headBranch} -> ${repoBaseBranch}`, {
      nullOnError,
      headBranch,
      baseBranch: repoBaseBranch,
      draft,
    });

    // Step 2: Create the pull request with retry for network errors
    const { data: pullRequestData } = await withNetworkRetry(
      () =>
        octokit.pulls.create({
          draft,
          owner,
          repo,
          title,
          body,
          head: headBranch,
          base: repoBaseBranch,
        }),
      "Failed to create pull request",
    );

    pullRequest = pullRequestData;
    logger.info(`🐙 Pull request created successfully!`, {
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
      headBranch,
      baseBranch: repoBaseBranch,
    });
  } catch (error) {
    logger.error(`Failed to create pull request`, {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
      headBranch,
      baseBranch: repoBaseBranch,
      nullOnError,
    });

    if (nullOnError) {
      return null;
    }

    if (error instanceof Error && error.message.includes("already exists")) {
      logger.info(
        "Pull request already exists. Getting existing pull request...",
        {
          nullOnError,
          headBranch,
        },
      );
      return getExistingPullRequest(
        owner,
        repo,
        headBranch,
        githubInstallationToken,
      );
    }

    return null;
  }

  try {
    logger.info("Adding 'open-swe' label to pull request", {
      pullRequestNumber: pullRequest.number,
    });
    await withNetworkRetry(
      () =>
        octokit.issues.addLabels({
          owner,
          repo,
          issue_number: pullRequest.number,
          labels: [getOpenSWELabel()],
        }),
      "Failed to add label to pull request",
    );
    logger.info("Added 'open-swe' label to pull request", {
      pullRequestNumber: pullRequest.number,
    });
  } catch (labelError) {
    logger.warn("Failed to add 'open-swe' label to pull request", {
      pullRequestNumber: pullRequest.number,
      labelError,
    });
  }

  return pullRequest;
}

export async function markPullRequestReadyForReview({
  owner,
  repo,
  pullNumber,
  title,
  body,
  githubInstallationToken,
}: {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  body: string;
  githubInstallationToken: string;
}): Promise<GitHubPullRequestUpdate | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      // Fetch the PR, as the markReadyForReview mutation requires the PR's node ID, not the pull number
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      await octokit.graphql(
        `
        mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: {
            pullRequestId: $pullRequestId
          }) {
            clientMutationId
            pullRequest {
              id
              number
              isDraft
            }
          }
        }
      `,
        {
          pullRequestId: pr.node_id,
        },
      );

      const { data: updatedPR } = await octokit.pulls.update({
        owner,
        repo,
        pull_number: pullNumber,
        title,
        body,
      });

      logger.info(`Pull request #${pullNumber} marked as ready for review.`);
      return updatedPR;
    },
    githubInstallationToken,
    "Failed to mark pull request as ready for review",
    { pullNumber, owner, repo },
    1,
  );
}

export async function updatePullRequest({
  owner,
  repo,
  pullNumber,
  title,
  body,
  githubInstallationToken,
}: {
  owner: string;
  repo: string;
  pullNumber: number;
  title?: string;
  body?: string;
  githubInstallationToken: string;
}) {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: pullRequest } = await octokit.pulls.update({
        owner,
        repo,
        pull_number: pullNumber,
        ...(title && { title }),
        ...(body && { body }),
      });

      return pullRequest;
    },
    githubInstallationToken,
    "Failed to update pull request",
    { pullNumber, owner, repo },
    1,
  );
}

export async function getIssue({
  owner,
  repo,
  issueNumber,
  githubInstallationToken,
  numRetries = 1,
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  githubInstallationToken: string;
  numRetries?: number;
}): Promise<GitHubIssue | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: issue } = await octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      return issue;
    },
    githubInstallationToken,
    "Failed to get issue",
    undefined,
    numRetries,
  );
}

export async function getIssueComments({
  owner,
  repo,
  issueNumber,
  githubInstallationToken,
  filterBotComments,
  numRetries = 1,
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  githubInstallationToken: string;
  filterBotComments: boolean;
  numRetries?: number;
}): Promise<GitHubIssueComment[] | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: comments } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
      });

      if (!filterBotComments) {
        return comments;
      }

      return comments.filter(
        (comment) =>
          comment.user?.type !== "Bot" &&
          !comment.user?.login?.includes("[bot]"),
      );
    },
    githubInstallationToken,
    "Failed to get issue comments",
    undefined,
    numRetries,
  );
}

export async function createIssue({
  owner,
  repo,
  title,
  body,
  githubAccessToken,
}: {
  owner: string;
  repo: string;
  title: string;
  body: string;
  githubAccessToken: string;
}): Promise<GitHubIssue | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: issue } = await octokit.issues.create({
        owner,
        repo,
        title,
        body,
      });

      return issue;
    },
    githubAccessToken,
    "Failed to create issue",
    { owner, repo, title },
    1,
  );
}

export async function updateIssue({
  owner,
  repo,
  issueNumber,
  githubInstallationToken,
  body,
  title,
  numRetries = 1,
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  githubInstallationToken: string;
  body?: string;
  title?: string;
  numRetries?: number;
}) {
  if (!body && !title) {
    throw new Error("Must provide either body or title to update issue");
  }

  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: issue } = await octokit.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        ...(body && { body }),
        ...(title && { title }),
      });

      return issue;
    },
    githubInstallationToken,
    "Failed to update issue",
    undefined,
    numRetries,
  );
}

export async function createIssueComment({
  owner,
  repo,
  issueNumber,
  body,
  githubToken,
  numRetries = 1,
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  /**
   * Can be either the installation token if creating a bot comment,
   * or an access token if creating a user comment.
   */
  githubToken: string;
  numRetries?: number;
}): Promise<GitHubIssueComment | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: comment } = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });

      return comment;
    },
    githubToken,
    "Failed to create issue comment",
    undefined,
    numRetries,
  );
}

export async function updateIssueComment({
  owner,
  repo,
  commentId,
  body,
  githubInstallationToken,
  numRetries = 1,
}: {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
  githubInstallationToken: string;
  numRetries?: number;
}): Promise<GitHubIssueComment | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: comment } = await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });

      return comment;
    },
    githubInstallationToken,
    "Failed to update issue comment",
    undefined,
    numRetries,
  );
}

export async function getBranch({
  owner,
  repo,
  branchName,
  githubInstallationToken,
}: {
  owner: string;
  repo: string;
  branchName: string;
  githubInstallationToken: string;
}): Promise<GitHubBranch | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: branch } = await octokit.repos.getBranch({
        owner,
        repo,
        branch: branchName,
      });

      return branch;
    },
    githubInstallationToken,
    "Failed to get branch",
    undefined,
    1,
    3,
    { skipLogOn404: true }, // Don't log error when branch doesn't exist (expected for new branches)
  );
}

export async function replyToReviewComment({
  owner,
  repo,
  commentId,
  body,
  pullNumber,
  githubInstallationToken,
}: {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
  pullNumber: number;
  githubInstallationToken: string;
}): Promise<GitHubReviewComment | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const { data: comment } = await octokit.pulls.createReplyForReviewComment(
        {
          owner,
          repo,
          comment_id: commentId,
          pull_number: pullNumber,
          body,
        },
      );

      return comment;
    },
    githubInstallationToken,
    "Failed to reply to review comment",
    undefined,
    1,
  );
}

export async function quoteReplyToPullRequestComment({
  owner,
  repo,
  commentId,
  body,
  pullNumber,
  originalCommentUserLogin,
  githubInstallationToken,
}: {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
  pullNumber: number;
  originalCommentUserLogin: string;
  githubInstallationToken: string;
}): Promise<GitHubIssueComment | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const originalComment = await octokit.issues.getComment({
        owner,
        repo,
        comment_id: commentId,
      });

      const quoteReply = `${originalComment.data.body ? `> ${originalComment.data.body}` : ""}
      
@${originalCommentUserLogin} ${body}`;

      const { data: comment } = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: quoteReply,
      });

      return comment;
    },
    githubInstallationToken,
    "Failed to quote reply to pull request comment",
    undefined,
    1,
  );
}

export async function quoteReplyToReview({
  owner,
  repo,
  reviewCommentId,
  body,
  pullNumber,
  originalCommentUserLogin,
  githubInstallationToken,
}: {
  owner: string;
  repo: string;
  reviewCommentId: number;
  body: string;
  pullNumber: number;
  originalCommentUserLogin: string;
  githubInstallationToken: string;
}): Promise<GitHubIssueComment | null> {
  return withGitHubRetry(
    async (token: string) => {
      const octokit = new Octokit({
        auth: token,
      });

      const originalComment = await octokit.pulls.getReview({
        owner,
        repo,
        pull_number: pullNumber,
        review_id: reviewCommentId,
      });

      const quoteReply = `${originalComment.data.body ? `> ${originalComment.data.body}` : ""}
      
@${originalCommentUserLogin} ${body}`;

      const { data: comment } = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: quoteReply,
      });

      return comment;
    },
    githubInstallationToken,
    "Failed to quote reply to pull request review",
    undefined,
    1,
  );
}
