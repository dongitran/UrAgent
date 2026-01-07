import { WebhookHandlerBase } from "./webhook-handler-base.js";
import {
  getOpenSWEAutoAcceptLabel,
  getOpenSWELabel,
  getOpenSWEMaxLabel,
  getOpenSWEMaxAutoAcceptLabel,
} from "../../utils/github/label.js";
import { RequestSource } from "../../constants.js";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { generateInitialComment } from "../../utils/github/initial-comment.js";

class IssueWebhookHandler extends WebhookHandlerBase {
  constructor() {
    super("GitHubIssueHandler");
  }

  async handleIssueLabeled(payload: any) {
    if (!process.env.SECRETS_ENCRYPTION_KEY) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEY environment variable is required",
      );
    }

    const validOpenSWELabels = [
      getOpenSWELabel(),
      getOpenSWEAutoAcceptLabel(),
      getOpenSWEMaxLabel(),
      getOpenSWEMaxAutoAcceptLabel(),
    ];

    if (
      !payload.label?.name ||
      !validOpenSWELabels.some((l) => l === payload.label?.name)
    ) {
      return;
    }

    const isAutoAcceptLabel =
      payload.label.name === getOpenSWEAutoAcceptLabel() ||
      payload.label.name === getOpenSWEMaxAutoAcceptLabel();

    const isMaxLabel =
      payload.label.name === getOpenSWEMaxLabel() ||
      payload.label.name === getOpenSWEMaxAutoAcceptLabel();

    this.logger.info(
      `'${payload.label.name}' label added to issue #${payload.issue.number}`,
      {
        isAutoAcceptLabel,
        isMaxLabel,
      },
    );

    try {
      const context = await this.setupWebhookContext(payload);
      if (!context) {
        return;
      }

      const issueData = {
        issueNumber: payload.issue.number,
        issueTitle: payload.issue.title,
        issueBody: payload.issue.body || "",
      };

      // Use DEFAULT_BRANCH from env if set, otherwise fallback to GitHub's default_branch
      const baseBranch = process.env.DEFAULT_BRANCH || payload.repository?.default_branch || "main";
      
      const runInput = {
        messages: [
          this.createHumanMessage(
            `**${issueData.issueTitle}**\n\n${issueData.issueBody}`,
            RequestSource.GITHUB_ISSUE_WEBHOOK,
            {
              isOriginalIssue: true,
              githubIssueId: issueData.issueNumber,
            },
          ),
        ],
        githubIssueId: issueData.issueNumber,
        targetRepository: {
          owner: context.owner,
          repo: context.repo,
          branch: baseBranch,
        },
        autoAcceptPlan: isAutoAcceptLabel,
      };

      // Create config object with Claude Opus 4.1 model configuration for max labels
      const configurable: Partial<GraphConfig["configurable"]> = isMaxLabel
        ? {
            plannerModelName: "anthropic:claude-opus-4-1",
            programmerModelName: "anthropic:claude-opus-4-1",
          }
        : {};

      const { runId, threadId } = await this.createRun(context, {
        runInput,
        configurable,
      });

      // Generate natural initial comment using AI (matches issue language)
      const initialMessage = await generateInitialComment({
        issueTitle: issueData.issueTitle,
        issueBody: issueData.issueBody,
        isAutoAccept: isAutoAcceptLabel,
      });

      await this.createComment(
        context,
        {
          issueNumber: issueData.issueNumber,
          message: initialMessage,
        },
        runId,
        threadId,
      );
    } catch (error) {
      this.handleError(error, "issue webhook");
    }
  }
}

const issueHandler = new IssueWebhookHandler();

export async function handleIssueLabeled(payload: any) {
  return issueHandler.handleIssueLabeled(payload);
}
