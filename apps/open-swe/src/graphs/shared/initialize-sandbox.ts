import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getGitHubTokensFromConfig } from "../../utils/github-tokens.js";
import {
  CustomRules,
  GraphConfig,
  TargetRepository,
} from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { getProvider } from "../../utils/sandbox.js";
import {
  FAILED_TO_GENERATE_TREE_MESSAGE,
  getCodebaseTree,
} from "../../utils/tree.js";
import { DO_NOT_RENDER_ID_PREFIX } from "@openswe/shared/constants";
import {
  CustomNodeEvent,
  INITIALIZE_NODE_ID,
} from "@openswe/shared/open-swe/custom-node-events";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { getDefaultTemplate, getDefaultUser, DEFAULT_SANDBOX_CREATE_PARAMS } from "../../constants.js";
import { getCustomRulesWithSandboxInstance } from "../../utils/custom-rules.js";
import { withRetry } from "../../utils/retry.js";
import {
  isLocalMode,
} from "@openswe/shared/open-swe/local-mode";
import { ISandbox, SandboxProviderType } from "../../utils/sandbox-provider/types.js";
import { getBranch } from "../../utils/github/api.js";

const logger = createLogger(LogLevel.INFO, "InitializeSandbox");

type InitializeSandboxState = {
  targetRepository: TargetRepository;
  branchName: string;
  sandboxSessionId?: string;
  codebaseTree?: string;
  messages?: BaseMessage[];
  internalMessages?: BaseMessage[];
  dependenciesInstalled?: boolean;
  customRules?: CustomRules;
};

export async function initializeSandbox(
  state: InitializeSandboxState,
  config: GraphConfig,
): Promise<Partial<InitializeSandboxState>> {
  const { sandboxSessionId, targetRepository, branchName } = state;
  
  // Determine provider type for path resolution
  const provider = getProvider();
  const providerType = provider.name; // 'daytona' or 'e2b'
  
  const absoluteRepoDir = getRepoAbsolutePath(targetRepository, undefined, providerType);
  const repoName = `${targetRepository.owner}/${targetRepository.repo}`;

  const events: CustomNodeEvent[] = [];
  const emitStepEvent = (
    base: CustomNodeEvent,
    status: "pending" | "success" | "error" | "skipped",
    error?: string,
  ) => {
    const event = {
      ...base,
      createdAt: new Date().toISOString(),
      data: {
        ...base.data,
        status,
        ...(error ? { error } : {}),
        runId: config.configurable?.run_id ?? "",
      },
    };
    events.push(event);
    try {
      config.writer?.(event);
    } catch (err) {
      logger.error("Failed to emit custom event", { event, err });
    }
  };
  const createEventsMessage = () => [
    new AIMessage({
      id: `${DO_NOT_RENDER_ID_PREFIX}${uuidv4()}`,
      content: "Initialize sandbox",
      additional_kwargs: {
        hidden: true,
        customNodeEvents: events,
      },
    }),
  ];

  // Check if we're in local mode before trying to get GitHub tokens
  if (isLocalMode(config)) {
    return initializeSandboxLocal(
      state,
      config,
      emitStepEvent,
      createEventsMessage,
    );
  }

  const { githubInstallationToken } = await getGitHubTokensFromConfig(config);

  if (!sandboxSessionId) {
    emitStepEvent(
      {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: uuidv4(),
        action: "Resuming sandbox",
        data: {
          status: "skipped",
          branch: branchName,
          repo: repoName,
        },
      },
      "skipped",
    );
    emitStepEvent(
      {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: uuidv4(),
        action: "Pulling latest changes",
        data: {
          status: "skipped",
          branch: branchName,
          repo: repoName,
        },
      },
      "skipped",
    );
  }

  // Resume existing sandbox flow
  if (sandboxSessionId) {
    const resumeSandboxActionId = uuidv4();
    const baseResumeSandboxAction: CustomNodeEvent = {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: resumeSandboxActionId,
      action: "Resuming sandbox",
      data: {
        status: "pending",
        sandboxSessionId,
        branch: branchName,
        repo: repoName,
      },
    };
    emitStepEvent(baseResumeSandboxAction, "pending");

    try {
      // Use provider abstraction to get sandbox - works with both Daytona and E2B
      const provider = getProvider();
      logger.info(`Resuming sandbox using provider: ${provider.name}`, { sandboxSessionId });
      const existingSandboxInstance = await provider.get(sandboxSessionId);
      emitStepEvent(baseResumeSandboxAction, "success");

      const pullLatestChangesActionId = uuidv4();
      const basePullLatestChangesAction: CustomNodeEvent = {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: pullLatestChangesActionId,
        action: "Pulling latest changes",
        data: {
          status: "pending",
          sandboxSessionId,
          branch: branchName,
          repo: repoName,
        },
      };
      emitStepEvent(basePullLatestChangesAction, "pending");

      // Use ISandbox.git.pull() instead of pullLatestChanges() for provider abstraction
      try {
        await existingSandboxInstance.git.pull({
          workdir: absoluteRepoDir,
          username: "x-access-token",
          token: githubInstallationToken,
        });
        emitStepEvent(basePullLatestChangesAction, "success");
      } catch (pullError) {
        logger.warn("Failed to pull latest changes", {
          error: pullError instanceof Error ? pullError.message : String(pullError),
        });
        emitStepEvent(basePullLatestChangesAction, "skipped");
        throw new Error("Failed to pull latest changes.");
      }

      const generateCodebaseTreeActionId = uuidv4();
      const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
        nodeId: INITIALIZE_NODE_ID,
        createdAt: new Date().toISOString(),
        actionId: generateCodebaseTreeActionId,
        action: "Generating codebase tree",
        data: {
          status: "pending",
          sandboxSessionId,
          branch: branchName,
          repo: repoName,
        },
      };
      emitStepEvent(baseGenerateCodebaseTreeAction, "pending");
      try {
        const codebaseTree = await getCodebaseTree(config, existingSandboxInstance.id);
        if (codebaseTree === FAILED_TO_GENERATE_TREE_MESSAGE) {
          emitStepEvent(
            baseGenerateCodebaseTreeAction,
            "error",
            FAILED_TO_GENERATE_TREE_MESSAGE,
          );
        } else {
          emitStepEvent(baseGenerateCodebaseTreeAction, "success");
        }

        const eventsMessages = createEventsMessage();
        const userMessages = state.messages || [];

        return {
          sandboxSessionId: existingSandboxInstance.id,
          codebaseTree,
          messages: eventsMessages,
          internalMessages: [...userMessages, ...eventsMessages],
          customRules: await getCustomRulesWithSandboxInstance(
            existingSandboxInstance,
            absoluteRepoDir,
            config,
          ),
        };
      } catch {
        emitStepEvent(
          baseGenerateCodebaseTreeAction,
          "error",
          FAILED_TO_GENERATE_TREE_MESSAGE,
        );
        const eventsMessages = createEventsMessage();
        const userMessages = state.messages || [];

        return {
          sandboxSessionId: existingSandboxInstance.id,
          codebaseTree: FAILED_TO_GENERATE_TREE_MESSAGE,
          messages: eventsMessages,
          internalMessages: [...userMessages, ...eventsMessages],
          customRules: await getCustomRulesWithSandboxInstance(
            existingSandboxInstance,
            absoluteRepoDir,
            config,
          ),
        };
      }
    } catch {
      emitStepEvent(
        baseResumeSandboxAction,
        "skipped",
        "Unable to resume sandbox. A new environment will be created.",
      );
    }
  }

  // Creating new sandbox
  const createSandboxActionId = uuidv4();
  const baseCreateSandboxAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: createSandboxActionId,
    action: "Creating sandbox",
    data: {
      status: "pending",
      sandboxSessionId: null,
      branch: branchName,
      repo: repoName,
    },
  };

  emitStepEvent(baseCreateSandboxAction, "pending");
  let sandboxInstance: ISandbox;
  try {
    // Use provider abstraction to create sandbox - works with Daytona, E2B, and Multi
    const provider = getProvider();
    
    // For multi-provider, the provider itself handles template/user selection
    // For single providers, we need to determine the correct template/user
    let template: string;
    let user: string;
    
    if (provider.name === 'multi') {
      // Multi-provider handles this internally, but we still need defaults
      // The actual template/user will be determined by the selected sub-provider
      template = getDefaultTemplate(SandboxProviderType.E2B); // Default to E2B template
      user = getDefaultUser(SandboxProviderType.E2B);
    } else {
      const providerType = provider.name === 'e2b' ? SandboxProviderType.E2B : SandboxProviderType.DAYTONA;
      template = getDefaultTemplate(providerType);
      user = getDefaultUser(providerType);
    }
    
    logger.info(`Creating sandbox using provider: ${provider.name}`, { template, user });
    sandboxInstance = await provider.create({
      template,
      user,
      autoDeleteInterval: DEFAULT_SANDBOX_CREATE_PARAMS.autoDeleteInterval,
    });
    logger.info(`Sandbox created successfully via ${provider.name}`, { sandboxId: sandboxInstance.id });
    emitStepEvent(baseCreateSandboxAction, "success");
  } catch (e) {
    logger.error("Failed to create sandbox environment", { e });
    emitStepEvent(
      baseCreateSandboxAction,
      "error",
      "Failed to create sandbox environment. Please try again later.",
    );
    throw new Error("Failed to create sandbox environment.");
  }

  // Cloning repository using ISandbox.git.clone()
  const cloneRepoActionId = uuidv4();
  const baseCloneRepoAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: cloneRepoActionId,
    action: "Cloning repository",
    data: {
      status: "pending",
      sandboxSessionId: sandboxInstance.id,
      branch: branchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseCloneRepoAction, "pending");

  const cloneUrl = `https://github.com/${targetRepository.owner}/${targetRepository.repo}.git`;
  
  // Check if branch exists on remote (same logic as original code)
  const branchExists = branchName
    ? !!(await getBranch({
        owner: targetRepository.owner,
        repo: targetRepository.repo,
        branchName,
        githubInstallationToken,
      }))
    : false;
  
  logger.info("Branch existence check", {
    branchName,
    branchExists,
    baseBranch: targetRepository.branch,
  });
  
  const cloneRepoRes = await withRetry(
    async () => {
      try {
        // If branch exists on remote, clone it directly
        // Otherwise, clone the base branch and create new branch locally
        const branchToClone = branchExists ? branchName : targetRepository.branch;
        
        await sandboxInstance.git.clone({
          url: cloneUrl,
          targetDir: absoluteRepoDir,
          branch: branchToClone,
          commit: branchExists ? undefined : targetRepository.baseCommit,
          username: "x-access-token", // GitHub requires x-access-token for installation tokens
          token: githubInstallationToken,
          // Pass base branch for reference (needed for git diff in E2B)
          baseBranch: targetRepository.branch,
        });
        
        // If branch didn't exist, create it locally and push
        if (!branchExists && branchName && branchName !== targetRepository.branch) {
          logger.info("Creating new branch from base", {
            branchName,
            baseBranch: targetRepository.branch,
          });
          
          try {
            await sandboxInstance.git.createBranch(absoluteRepoDir, branchName);
            logger.info("Branch created locally", { branchName });
          } catch (createError) {
            logger.warn("Failed to create branch (may already exist locally)", {
              branchName,
              error: createError instanceof Error ? createError.message : String(createError),
            });
          }
          
          // Push to create branch on remote
          try {
            await sandboxInstance.git.push({
              workdir: absoluteRepoDir,
              username: "x-access-token",
              token: githubInstallationToken,
              branch: branchName,
            });
            logger.info("Pushed new branch to remote", { branchName });
          } catch (pushError) {
            logger.warn("Failed to push branch to remote", {
              branchName,
              error: pushError instanceof Error ? pushError.message : String(pushError),
            });
          }
        }
        
        return branchName || targetRepository.branch;
      } catch (error) {
        logger.error("Clone repository failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    { retries: 0, delay: 0 },
  );

  if (
    cloneRepoRes instanceof Error &&
    !cloneRepoRes.message.includes("repository already exists")
  ) {
    emitStepEvent(
      baseCloneRepoAction,
      "error",
      "Failed to clone repository. Please check your repo URL and permissions.",
    );
    const errorFields = {
      ...(cloneRepoRes instanceof Error
        ? {
            name: cloneRepoRes.name,
            message: cloneRepoRes.message,
            stack: cloneRepoRes.stack,
          }
        : cloneRepoRes),
    };
    logger.error("Cloning repository failed", errorFields);
    throw new Error("Failed to clone repository.");
  }
  const newBranchName =
    typeof cloneRepoRes === "string" ? cloneRepoRes : branchName;
  emitStepEvent(baseCloneRepoAction, "success");

  // Checking out branch
  const checkoutBranchActionId = uuidv4();
  const baseCheckoutBranchAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: checkoutBranchActionId,
    action: "Checking out branch",
    data: {
      status: "pending",
      sandboxSessionId: sandboxInstance.id,
      branch: newBranchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseCheckoutBranchAction, "success");

  // Generating codebase tree
  const generateCodebaseTreeActionId = uuidv4();
  const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: generateCodebaseTreeActionId,
    action: "Generating codebase tree",
    data: {
      status: "pending",
      sandboxSessionId: sandboxInstance.id,
      branch: newBranchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseGenerateCodebaseTreeAction, "pending");
  let codebaseTree: string | undefined;
  try {
    codebaseTree = await getCodebaseTree(config, sandboxInstance.id);
    emitStepEvent(baseGenerateCodebaseTreeAction, "success");
  } catch (_) {
    emitStepEvent(
      baseGenerateCodebaseTreeAction,
      "error",
      "Failed to generate codebase tree.",
    );
  }

  const eventsMessages = createEventsMessage();
  const userMessages = state.messages || [];

  return {
    sandboxSessionId: sandboxInstance.id,
    targetRepository,
    codebaseTree,
    messages: eventsMessages,
    internalMessages: [...userMessages, ...eventsMessages],
    dependenciesInstalled: false,
    customRules: await getCustomRulesWithSandboxInstance(sandboxInstance, absoluteRepoDir, config),
    branchName: newBranchName,
  };
}

/**
 * Local mode version of initializeSandbox
 * Skips sandbox creation and repository cloning, works directly with local filesystem
 */
async function initializeSandboxLocal(
  state: InitializeSandboxState,
  config: GraphConfig,
  emitStepEvent: (
    base: CustomNodeEvent,
    status: "pending" | "success" | "error" | "skipped",
    error?: string,
  ) => void,
  createEventsMessage: () => BaseMessage[],
): Promise<Partial<InitializeSandboxState>> {
  const { targetRepository, branchName } = state;
  const repoName = `${targetRepository.owner}/${targetRepository.repo}`;

  // Skip sandbox creation in local mode
  emitStepEvent(
    {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: uuidv4(),
      action: "Creating sandbox",
      data: {
        status: "skipped",
        sandboxSessionId: null,
        branch: branchName,
        repo: repoName,
      },
    },
    "skipped",
  );

  // Skip repository cloning in local mode
  emitStepEvent(
    {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: uuidv4(),
      action: "Cloning repository",
      data: {
        status: "skipped",
        sandboxSessionId: null,
        branch: branchName,
        repo: repoName,
      },
    },
    "skipped",
  );

  // Skip branch checkout in local mode
  emitStepEvent(
    {
      nodeId: INITIALIZE_NODE_ID,
      createdAt: new Date().toISOString(),
      actionId: uuidv4(),
      action: "Checking out branch",
      data: {
        status: "skipped",
        sandboxSessionId: null,
        branch: branchName,
        repo: repoName,
      },
    },
    "skipped",
  );

  // Generate codebase tree locally
  const generateCodebaseTreeActionId = uuidv4();
  const baseGenerateCodebaseTreeAction: CustomNodeEvent = {
    nodeId: INITIALIZE_NODE_ID,
    createdAt: new Date().toISOString(),
    actionId: generateCodebaseTreeActionId,
    action: "Generating codebase tree",
    data: {
      status: "pending",
      sandboxSessionId: null,
      branch: branchName,
      repo: repoName,
    },
  };
  emitStepEvent(baseGenerateCodebaseTreeAction, "pending");

  let codebaseTree = undefined;
  try {
    codebaseTree = await getCodebaseTree(config, undefined, targetRepository);
    emitStepEvent(baseGenerateCodebaseTreeAction, "success");
  } catch (_) {
    emitStepEvent(
      baseGenerateCodebaseTreeAction,
      "error",
      "Failed to generate codebase tree.",
    );
  }

  // Create a mock sandbox ID for consistency
  const mockSandboxId = `local-${Date.now()}-${crypto.randomBytes(16).toString("hex")}`;

  const eventsMessages = createEventsMessage();
  const userMessages = state.messages || [];

  return {
    sandboxSessionId: mockSandboxId,
    targetRepository,
    codebaseTree,
    messages: eventsMessages,
    internalMessages: [...userMessages, ...eventsMessages],
    dependenciesInstalled: false,
    // In local mode, pass null for sandbox - getCustomRulesWithSandboxInstance handles this
    customRules: undefined,
    branchName: branchName,
  };
}
