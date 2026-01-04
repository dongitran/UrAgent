import { Sandbox } from "@daytonaio/sdk";
import { ISandbox } from "../sandbox-provider/types.js";

export interface LocalExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: {
    stdout: string;
    stderr?: string;
  };
}

export interface ExecuteCommandOptions {
  command: string | string[];
  workdir?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** @deprecated Use sandboxInstance instead for provider abstraction */
  sandbox?: Sandbox;
  /** New provider-agnostic sandbox instance */
  sandboxInstance?: ISandbox;
  sandboxSessionId?: string;
}
