import { MessagesZodState } from "@langchain/langgraph";
import { TargetRepository, TaskPlan, AgentSession } from "../types.js";
import { z } from "zod";
import { withLangGraph } from "@langchain/langgraph/zod";

export const ManagerGraphStateObj = MessagesZodState.extend({
  /**
   * The GitHub issue number that the user's request is associated with.
   * If not provided when the graph is invoked, it will create an issue.
   */
  githubIssueId: z.number(),
  /**
   * The GitHub pull request number of the PR which resolves the user's request.
   * If not provided when the graph is invoked, it will create a PR.
   */
  githubPullRequestId: z.number().optional(),
  /**
   * The target repository the request should be executed in.
   * When DEFAULT_REPOSITORY_* env vars are set, they take precedence over client input.
   * DEFAULT_BRANCH env var ALWAYS overrides client branch selection when set.
   */
  targetRepository: withLangGraph(z.custom<TargetRepository>(), {
    reducer: {
      schema: z.custom<TargetRepository>(),
      fn: (_state, update) => {
        // If default repository is configured in env, always use it (ignore client input)
        const defaultOwner = process.env.DEFAULT_REPOSITORY_OWNER;
        const defaultRepo = process.env.DEFAULT_REPOSITORY_NAME;
        const defaultBranch = process.env.DEFAULT_BRANCH;

        // Debug logging
        console.log("[ManagerGraphState] targetRepository reducer called", {
          defaultOwner,
          defaultRepo,
          defaultBranch,
          updateBranch: update?.branch,
          updateOwner: update?.owner,
          updateRepo: update?.repo,
        });

        if (defaultOwner && defaultRepo) {
          // When DEFAULT_BRANCH is set, ALWAYS use it (ignore client branch)
          // This ensures the agent always works on the configured base branch
          // When DEFAULT_BRANCH is NOT set, use client's branch or fallback to "main"
          const branch = defaultBranch 
            ? defaultBranch 
            : (update?.branch || "main");
          
          const result = {
            owner: defaultOwner,
            repo: defaultRepo,
            branch,
          };
          console.log("[ManagerGraphState] Using default repository config", result);
          return result;
        }
        // No default configured, use client input
        console.log("[ManagerGraphState] Using client input", update);
        return update;
      },
    },
    default: () => ({
      owner: process.env.DEFAULT_REPOSITORY_OWNER || "",
      repo: process.env.DEFAULT_REPOSITORY_NAME || "",
      branch: process.env.DEFAULT_BRANCH || "main",
    }),
  }),
  /**
   * The tasks generated for this request.
   */
  taskPlan: z.custom<TaskPlan>(),
  /**
   * The programmer session
   */
  programmerSession: z.custom<AgentSession>().optional(),
  /**
   * The planner session
   */
  plannerSession: z.custom<AgentSession>().optional(),
  /**
   * The branch name to checkout and make changes on.
   * Can be user specified, or defaults to empty string to force creation of a new feature branch.
   */
  branchName: withLangGraph(z.string(), {
    reducer: {
      schema: z.string(),
      fn: (_state, update) => update,
    },
    default: () => "",
  }),
  /**
   * Whether or not to auto accept the generated plan.
   */
  autoAcceptPlan: withLangGraph(z.custom<boolean>().optional(), {
    reducer: {
      schema: z.custom<boolean>().optional(),
      fn: (_state, update) => update,
    },
  }),
});

export type ManagerGraphState = z.infer<typeof ManagerGraphStateObj>;
export type ManagerGraphUpdate = Partial<ManagerGraphState>;
