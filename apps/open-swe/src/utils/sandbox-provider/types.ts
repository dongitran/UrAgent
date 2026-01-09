/**
 * Sandbox Provider Abstraction Layer
 * 
 * This module provides a unified interface for sandbox providers (Daytona, E2B, etc.)
 * allowing the application to switch between providers without changing business logic.
 */

import { GraphConfig } from "@openswe/shared/open-swe/types";

/**
 * Result of executing a command in the sandbox
 */
export interface ExecuteCommandResult {
  exitCode: number;
  result: string;
  artifacts?: {
    stdout: string;
    stderr?: string;
  };
}

/**
 * Options for executing a command
 */
export interface ExecuteCommandOptions {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeout?: number;
  user?: string;
  config?: GraphConfig;
}

/**
 * Options for creating a sandbox
 */
export interface CreateSandboxOptions {
  /** Template/snapshot name to use */
  template?: string;
  /** User to run commands as */
  user?: string;
  /** Auto-delete interval in minutes */
  autoDeleteInterval?: number;
  /** Timeout for sandbox creation in seconds */
  timeout?: number;
  /** Environment variables */
  envs?: Record<string, string>;
  /** Custom metadata */
  metadata?: Record<string, string>;
  /** Graph config for cancellation checks */
  config?: GraphConfig;
}

/**
 * Git clone options
 */
export interface GitCloneOptions {
  /** Repository URL */
  url: string;
  /** Target directory */
  targetDir: string;
  /** Branch to clone */
  branch?: string;
  /** Specific commit to checkout */
  commit?: string;
  /** Username for authentication */
  username?: string;
  /** Token/password for authentication */
  token?: string;
  /** Base branch for diff comparison (e.g., 'main') - will be fetched for reference */
  baseBranch?: string;
}

/**
 * Git operation options
 */
export interface GitOperationOptions {
  /** Working directory */
  workdir: string;
  /** Username for authentication */
  username?: string;
  /** Token/password for authentication */
  token?: string;
  /** Branch name (used for push --set-upstream) */
  branch?: string;
  /** Force push */
  force?: boolean;
}

/**
 * Git commit options
 */
export interface GitCommitOptions extends GitOperationOptions {
  message: string;
  authorName: string;
  authorEmail: string;
}

/**
 * Sandbox state enum
 */
export enum SandboxState {
  STARTED = 'started',
  STOPPED = 'stopped',
  ARCHIVED = 'archived',
  CREATING = 'creating',
  UNKNOWN = 'unknown',
}

/**
 * Sandbox information
 */
export interface SandboxInfo {
  id: string;
  state: SandboxState;
  template?: string;
  createdAt?: Date;
  metadata?: Record<string, string>;
}

/**
 * Abstract sandbox instance interface
 * Represents a running sandbox that can execute commands
 */
export interface ISandbox {
  /** Unique identifier */
  readonly id: string;

  /** Current state */
  readonly state: SandboxState;

  /** Provider type that created this sandbox ('daytona' or 'e2b') */
  readonly providerType: SandboxProviderType;

  /**
   * Execute a command in the sandbox
   */
  executeCommand(options: ExecuteCommandOptions): Promise<ExecuteCommandResult>;

  /**
   * Read a file from the sandbox
   */
  readFile(path: string): Promise<string>;

  /**
   * Write a file to the sandbox
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Check if a file/directory exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Create a directory
   */
  mkdir(path: string): Promise<void>;

  /**
   * Remove a file or directory
   */
  remove(path: string): Promise<void>;

  /**
   * Git operations
   */
  git: {
    clone(options: GitCloneOptions): Promise<void>;
    add(workdir: string, files: string[]): Promise<void>;
    commit(options: GitCommitOptions): Promise<void>;
    push(options: GitOperationOptions): Promise<void>;
    pull(options: GitOperationOptions): Promise<void>;
    createBranch(workdir: string, branchName: string): Promise<void>;
    status(workdir: string): Promise<string>;
  };

  /**
   * Start the sandbox (if stopped)
   */
  start(): Promise<void>;

  /**
   * Stop the sandbox
   */
  stop(): Promise<void>;

  /**
   * Extend sandbox timeout/lifetime
   * @param timeoutMs - New timeout in milliseconds from now
   */
  extendTimeout?(timeoutMs: number): Promise<void>;

  /**
   * Get the underlying native sandbox object
   * Use with caution - breaks abstraction
   */
  getNative<T>(): T;
}

/**
 * Sandbox provider interface
 * Factory for creating and managing sandboxes
 */
export interface ISandboxProvider {
  /** Provider name (e.g., 'daytona', 'e2b') */
  readonly name: string;

  /**
   * Create a new sandbox
   */
  create(options?: CreateSandboxOptions): Promise<ISandbox>;

  /**
   * Get an existing sandbox by ID
   */
  get(sandboxId: string): Promise<ISandbox>;

  /**
   * Stop a sandbox
   */
  stop(sandboxId: string): Promise<void>;

  /**
   * Delete a sandbox
   */
  delete(sandboxId: string): Promise<boolean>;

  /**
   * List all sandboxes
   */
  list(): Promise<SandboxInfo[]>;
}

/**
 * Provider type enum
 */
export enum SandboxProviderType {
  DAYTONA = 'daytona',
  E2B = 'e2b',
  LOCAL = 'local',
  /** Multi-provider mode: round-robin between Daytona and E2B */
  MULTI = 'multi',
}

/**
 * Provider configuration
 */
export interface SandboxProviderConfig {
  type: SandboxProviderType;

  /** Daytona-specific config */
  daytona?: {
    apiUrl?: string;
    apiKey?: string;
    defaultSnapshot?: string;
    defaultUser?: string;
  };

  /** E2B-specific config */
  e2b?: {
    apiKey?: string;
    defaultTemplate?: string;
    domain?: string;
  };

  /** Local mode config */
  local?: {
    workingDirectory?: string;
  };
}
