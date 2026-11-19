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
}

export declare function defaultSwarmHome(): string;
export declare function runSwarm(input: SwarmRequest, options?: SwarmOptions): Promise<unknown>;
