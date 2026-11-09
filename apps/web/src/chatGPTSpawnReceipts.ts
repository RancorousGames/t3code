import type { EnvironmentId } from "@t3tools/contracts";
import type { ChatGPTInitialPromptReceipt } from "./chatGPTBrowserAutomation";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import { readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { logChatGPTWorkerStartup } from "./chatGPTWorkerStartupDiagnostics";

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
export type SpawnReceipt = typeof SpawnReceipt.Type;
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
  const session = readChatGPTBrowserSessions(environmentId).find((s) => s.id === sessionId);
  if (session) logChatGPTWorkerStartup(environmentId, session, "created", next.at(-1) ?? null);
}

/** Persist UNKNOWN before dispatch. Losing the renderer never makes a send replay-safe. */
export function startChatGPTSpawnDelivery(
  environmentId: EnvironmentId,
  requestId: string,
  sessionId: string,
  send: () => Promise<ChatGPTInitialPromptReceipt>,
  options: { retryDefinitelyNotSent?: boolean } = {},
): Promise<void> {
  const key = deliveryKey(environmentId, requestId);
  const active = activeInitialDeliveries.get(key);
  if (active) return active;
  const existing = readChatGPTSpawnReceipts(environmentId).find((r) => r.requestId === requestId);
  if (!existing || existing.sessionId !== sessionId)
    throw new Error("Initial delivery requires the exact persisted spawn reservation.");
  // Only an explicit confirmed pre-submit failure may be attempted again.
  // UNKNOWN or sendAttempted=true may already have posted a user turn: never replay.
  const safeRetry = options.retryDefinitelyNotSent === true &&
    existing.initialDelivery?.delivery === "not_sent" &&
    existing.initialDelivery.sendAttempted === false;
  if (existing.initialDelivery && !safeRetry) return Promise.resolve();
  const save = (
    initialDelivery: NonNullable<SpawnReceipt["initialDelivery"]>,
    stage: "delivery_started" | "delivery_finished",
  ) => {
    const current = getLocalStorageItem(STORAGE_KEY, SpawnReceipts) ?? [];
    if (!current.some((r) => r.requestId === requestId && r.sessionId === sessionId))
      throw new Error("Spawn reservation disappeared; preserve UNKNOWN delivery.");
    const updated = current.map((r) =>
      r.requestId === requestId && r.sessionId === sessionId ? { ...r, initialDelivery } : r
    );
    setLocalStorageItem(STORAGE_KEY, updated, SpawnReceipts);
    const session = readChatGPTBrowserSessions(environmentId).find((s) => s.id === sessionId);
    if (session) logChatGPTWorkerStartup(
      environmentId, session, stage,
      updated.find((r) => r.requestId === requestId) ?? null,
    );
  };
  save({ delivery: "unknown", sendAttempted: null, reason: "Initial delivery has not been confirmed. Do not replay this spawn." }, "delivery_started");
  const pending = Promise.resolve().then(send).then(
    (receipt) => save(receipt, "delivery_finished"),
    (error: unknown) => save({
      delivery: "unknown",
      sendAttempted: null,
      reason: error instanceof Error ? error.message : String(error),
    }, "delivery_finished"),
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
