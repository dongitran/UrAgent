import * as fs from "fs/promises";
import * as path from "path";
import { getLocalShellExecutor } from "../shell-executor/local-shell-executor.js";
import {
    ISandbox,
    ISandboxProvider,
    SandboxState,
    SandboxInfo,
    CreateSandboxOptions,
    ExecuteCommandOptions,
    ExecuteCommandResult,
    GitCloneOptions,
    GitOperationOptions,
    GitCommitOptions,
    SandboxProviderType,
} from "./types.js";

/**
 * Local Sandbox implementation implementing ISandbox
 * Runs commands and file operations on the host machine
 */
export class LocalSandbox implements ISandbox {
    readonly id: string;
    private workingDirectory: string;

    constructor(id: string, workingDirectory: string = process.cwd()) {
        this.id = id;
        this.workingDirectory = workingDirectory;
    }

    get state(): SandboxState {
        return SandboxState.STARTED;
    }

    get providerType(): SandboxProviderType {
        return SandboxProviderType.LOCAL;
    }

    async executeCommand(options: ExecuteCommandOptions): Promise<ExecuteCommandResult> {
        const executor = getLocalShellExecutor(this.workingDirectory);
        const result = await executor.executeCommand(options.command, {
            workdir: options.workdir,
            env: options.env,
            timeout: options.timeout,
            localMode: true,
        });

        return {
            exitCode: result.exitCode,
            result: result.result,
            artifacts: result.artifacts,
        };
    }

    async readFile(filePath: string): Promise<string> {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workingDirectory, filePath);
        return await fs.readFile(absolutePath, "utf-8");
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workingDirectory, filePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, "utf-8");
    }

    async exists(filePath: string): Promise<boolean> {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workingDirectory, filePath);
        try {
            await fs.access(absolutePath);
            return true;
        } catch {
            return false;
        }
    }

    async mkdir(dirPath: string): Promise<void> {
        const absolutePath = path.isAbsolute(dirPath)
            ? dirPath
            : path.join(this.workingDirectory, dirPath);
        await fs.mkdir(absolutePath, { recursive: true });
    }

    async remove(filePath: string): Promise<void> {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workingDirectory, filePath);
        await fs.rm(absolutePath, { recursive: true, force: true });
    }

    git = {
        clone: async (options: GitCloneOptions): Promise<void> => {
            let command = `git clone`;
            if (options.branch) {
                command += ` -b ${options.branch}`;
            }

            // Use URL with token if provided
            let url = options.url;
            if (options.token) {
                url = url.replace("https://", `https://${options.username || "x-access-token"}:${options.token}@`);
            }

            command += ` "${url}" "${options.targetDir}"`;

            const result = await this.executeCommand({
                command,
                timeout: 300,
            });

            if (result.exitCode !== 0) {
                throw new Error(`Git clone failed: ${result.result}`);
            }

            if (options.commit) {
                await this.executeCommand({
                    command: `git checkout ${options.commit}`,
                    workdir: options.targetDir,
                });
            }
        },

        add: async (workdir: string, files: string[]): Promise<void> => {
            await this.executeCommand({
                command: `git add ${files.join(" ")}`,
                workdir,
            });
        },

        commit: async (options: GitCommitOptions): Promise<void> => {
            await this.executeCommand({
                command: `git -c user.name="${options.authorName}" -c user.email="${options.authorEmail}" commit -m "${options.message}"`,
                workdir: options.workdir,
            });
        },

        push: async (options: GitOperationOptions): Promise<void> => {
            let command = `git push`;
            if (options.force) command += " --force";
            if (options.branch) command += ` origin ${options.branch}`;

            const result = await this.executeCommand({
                command,
                workdir: options.workdir,
            });

            if (result.exitCode !== 0) {
                throw new Error(`Git push failed: ${result.result}`);
            }
        },

        pull: async (options: GitOperationOptions): Promise<void> => {
            const result = await this.executeCommand({
                command: `git pull`,
                workdir: options.workdir,
            });

            if (result.exitCode !== 0) {
                throw new Error(`Git pull failed: ${result.result}`);
            }
        },

        createBranch: async (workdir: string, branchName: string): Promise<void> => {
            await this.executeCommand({
                command: `git checkout -b ${branchName}`,
                workdir,
            });
        },

        status: async (workdir: string): Promise<string> => {
            const result = await this.executeCommand({
                command: `git status --porcelain`,
                workdir,
            });
            return result.result;
        },
    };

    async start(): Promise<void> {
        // Local mode is always started
    }

    async stop(): Promise<void> {
        // Local mode doesn't need stopping
    }

    getNative<T>(): T {
        return null as any;
    }
}

/**
 * Provider for local sandboxes
 */
export class LocalSandboxProvider implements ISandboxProvider {
    readonly name = "local";

    async create(_options?: CreateSandboxOptions): Promise<ISandbox> {
        const id = `local-${Date.now()}`;
        return new LocalSandbox(id);
    }

    async get(sandboxId: string): Promise<ISandbox> {
        return new LocalSandbox(sandboxId);
    }

    async stop(_sandboxId: string): Promise<void> {
        // No-op
    }

    async delete(_sandboxId: string): Promise<boolean> {
        return true;
    }

    async list(): Promise<SandboxInfo[]> {
        return [{
            id: "local",
            state: SandboxState.STARTED,
        }];
    }
}

let localProviderInstance: LocalSandboxProvider | null = null;

export function getLocalProvider(): LocalSandboxProvider {
    if (!localProviderInstance) {
        localProviderInstance = new LocalSandboxProvider();
    }
    return localProviderInstance;
}
