import type { ExecutionReceiptInput } from "./openRigExecutionReceiptBridge.js";

/** Normalize only *committed* V2 run events, never provider progress guesses. */
export function nativeV2ExecutionReceipt(input: {
  seatId: string;
  environmentId: string;
  threadId: string;
  eventId: string;
  runId: string;
  occurredAt: string;
  eventType: "run.created" | "run.updated";
  status: "preparing" | "queued" | "starting" | "running" | "waiting" |
    "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";
}): ExecutionReceiptInput | null {
  const phase = input.eventType === "run.created" ? "accepted-intent"
    : input.status === "running" ? "run-started"
    : input.status === "completed" ? "result-committed"
    : ["interrupted", "failed", "cancelled", "rolled_back"].includes(input.status)
      ? "terminal" : null;
  if (!phase) return null;
  return {
    seatId: input.seatId,
    origin: { kind: "native", environmentId: input.environmentId,
      threadId: input.threadId, generation: input.runId },
    sourceEventId: input.eventId,
    phase,
    at: input.occurredAt,
  };
}
