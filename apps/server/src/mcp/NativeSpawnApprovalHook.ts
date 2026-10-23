import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { NATIVE_SPAWN_APPROVAL_HOLD_CONSTRAINT } from "../orchestration-v2/NativeSpawnPolicy.ts";

// Remove this hold only when create_threads consumes a trusted, durable one-use
// decision before dispatch. Until then even codex:gpt-6-luna is blocked here.
export const nativeCreateHold: Effect.Effect<void, OrchestratorMcpFailure> = Effect.fail(
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "create_threads is disabled until authenticated, single-use human spawn approval is available.",
  }),
);

// Agent-facing catalog flags are deliberately not authority to dispatch.
export function unavailableNativeSpawnCapabilities(constraints: readonly string[]) {
  return {
    canRunChildTask: false as const,
    canRunCrossProviderChildTask: false as const,
    constraints: [...constraints, NATIVE_SPAWN_APPROVAL_HOLD_CONSTRAINT],
  };
}
