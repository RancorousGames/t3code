import type { SwarmOptions } from "./index.mjs";

export interface NativeSwarmInput {
  readonly action: "read" | "post";
  readonly swarmId: string;
  readonly afterMessageId?: string | undefined;
  readonly limit?: number | undefined;
  readonly messageId?: string | undefined;
  readonly body?: string | undefined;
  readonly mentions?: ReadonlyArray<string> | undefined;
}
export interface NativeSwarmContext {
  readonly root: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly transports?: SwarmOptions["transports"];
}
export declare function swarmForNativeThread(
  input: NativeSwarmInput,
  context: NativeSwarmContext,
): Promise<{ actor: string; data: unknown }>;
