import type {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";

export interface SwarmRequest {
  readonly action: string;
  readonly [field: string]: unknown;
}

export interface SwarmOptions {
  readonly root?: string;
  readonly enabled?: boolean;
  readonly transports?: {
    readonly native: (request: Record<string, unknown>) => Promise<unknown>;
    readonly chatgpt: (request: Record<string, unknown>) => Promise<unknown>;
  };
  readonly coordinatorCaller?: { readonly threadId: string; readonly environmentId: string };
  readonly delegate?: (
    request: OrchestratorMcpDelegateTaskInput,
  ) => Promise<OrchestratorMcpDelegateTaskResult>;
  readonly taskStatus?: (taskId: string) => Promise<OrchestratorMcpDelegateTaskResult>;
}

export declare function defaultSwarmHome(): string;
export declare function runSwarm(input: SwarmRequest, options?: SwarmOptions): Promise<unknown>;
