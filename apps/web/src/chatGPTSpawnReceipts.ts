import type { EnvironmentId } from "@t3tools/contracts";
import type { ChatGPTInitialPromptReceipt } from "./chatGPTBrowserAutomation";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const SpawnReceipt = Schema.Struct({
  requestId: Schema.String,
  environmentId: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.Number,
  initialDelivery: Schema.optional(Schema.Struct({
    delivery: Schema.Literals(["user_turn_observed", "unknown", "not_sent"]),
    sendAttempted: Schema.NullOr(Schema.Boolean),
    reason: Schema.optional(Schema.String),
  })),
});
const SpawnReceipts = Schema.Array(SpawnReceipt);
type SpawnReceipt = typeof SpawnReceipt.Type;
const activeInitialDeliveries = new Map<string, Promise<void>>();
const deliveryKey = (environmentId: string, requestId: string) => `${environmentId}:${requestId}`;
const STORAGE_KEY = "t3code:chatgpt-browser:spawn-receipts:v1";

// Stored immediately after createSession. The broker may lose its renderer
// response later; a read-only sessions.list can still correlate the UUID.
export function recordChatGPTSpawnCreated(
  environmentId: EnvironmentId,
  requestId: string,
  sessionId: string,
): void {
  const current = getLocalStorageItem(STORAGE_KEY, SpawnReceipts) ?? [];
  const existing = current.find((receipt) => receipt.requestId === requestId);
  if (existing) {
    if (existing.environmentId !== environmentId || existing.sessionId !== sessionId)
      throw new Error("Spawn request ID already belongs to another session. Reconcile the original receipt.");
    return;
  }
  const next: SpawnReceipt[] = [
    ...current,
    { requestId, environmentId, sessionId, createdAt: Date.now() },
  ].filter((receipt, index, all) =>
    index >= all.length - 256 || receipt.initialDelivery?.delivery === "unknown",
  );
  setLocalStorageItem(STORAGE_KEY, next, SpawnReceipts);
}

/** Persist UNKNOWN before dispatch. Losing the renderer never makes a send replay-safe. */
export function startChatGPTSpawnDelivery(
  environmentId: EnvironmentId,
  requestId: string,
  sessionId: string,
  send: () => Promise<ChatGPTInitialPromptReceipt>,
): Promise<void> {
  const key = deliveryKey(environmentId, requestId);
  const active = activeInitialDeliveries.get(key);
  if (active) return active;
  const existing = readChatGPTSpawnReceipts(environmentId).find((r) => r.requestId === requestId);
  if (!existing || existing.sessionId !== sessionId)
    throw new Error("Initial delivery requires the exact persisted spawn reservation.");
  // A prior durable attempt, including UNKNOWN, must never be dispatched again.
  if (existing.initialDelivery) return Promise.resolve();
  const save = (initialDelivery: NonNullable<SpawnReceipt["initialDelivery"]>) => {
    const current = getLocalStorageItem(STORAGE_KEY, SpawnReceipts) ?? [];
    if (!current.some((r) => r.requestId === requestId && r.sessionId === sessionId))
      throw new Error("Spawn reservation disappeared; preserve UNKNOWN delivery.");
    setLocalStorageItem(STORAGE_KEY, current.map((r) =>
      r.requestId === requestId && r.sessionId === sessionId ? { ...r, initialDelivery } : r
    ), SpawnReceipts);
  };
  save({ delivery: "unknown", sendAttempted: null, reason: "Initial delivery has not been confirmed. Do not replay this spawn." });
  const pending = Promise.resolve().then(send).then(
    (receipt) => save(receipt),
    (error: unknown) => save({
      delivery: "unknown",
      sendAttempted: null,
      reason: error instanceof Error ? error.message : String(error),
    }),
  ).catch((error: unknown) => {
    // The pre-dispatch UNKNOWN receipt remains the durable truth if saving the
    // outcome fails. Do not turn a persistence failure into another send.
    console.warn("[ChatGPT spawn] Could not persist initial delivery outcome.", error);
  }).finally(() => {
    activeInitialDeliveries.delete(key);
  });
  activeInitialDeliveries.set(key, pending);
  return pending;
}

export function chatGPTSpawnDeliveryStatus(environmentId: EnvironmentId, receipt: SpawnReceipt) {
  return {
    promptDelivery: activeInitialDeliveries.has(deliveryKey(environmentId, receipt.requestId))
      ? "pending" as const
      : receipt.initialDelivery?.delivery ?? "unknown" as const,
    messageSent: receipt.initialDelivery?.delivery === "user_turn_observed",
    sendAttempted: receipt.initialDelivery?.sendAttempted ?? null,
    ...(receipt.initialDelivery?.reason ? { reason: receipt.initialDelivery.reason } : {}),
  };
}

export function readChatGPTSpawnReceipts(environmentId: EnvironmentId): readonly SpawnReceipt[] {
  return (getLocalStorageItem(STORAGE_KEY, SpawnReceipts) ?? []).filter(
    (receipt) => receipt.environmentId === environmentId,
  );
}
