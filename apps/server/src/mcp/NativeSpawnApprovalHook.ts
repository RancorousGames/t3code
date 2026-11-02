import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { NATIVE_SPAWN_APPROVAL_HOLD_CONSTRAINT } from "../orchestration-v2/NativeSpawnPolicy.ts";

// The provider catalog is only a preflight. A native child requires an online,
// authenticated, durable one-use approval consumed BEFORE any dispatch.
export const nativeCreateHold: Effect.Effect<void, OrchestratorMcpFailure> = Effect.fail(
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "create_threads is disabled until authenticated, single-use human spawn approval is available.",
  }),
);

// Capability display must never advertise unrestricted child execution.
export function unavailableNativeSpawnCapabilities(constraints: readonly string[]) {
  return {
    canRunChildTask: false as const,
    canRunCrossProviderChildTask: false as const,
    constraints: [...constraints, NATIVE_SPAWN_APPROVAL_HOLD_CONSTRAINT],
  };
}