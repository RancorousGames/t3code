/**
 * Wake policy belongs to the durable T3 owner. This reducer owns trigger and
 * receipt transitions; the outbox alone owns submission and its immutable target.
 * Runtime availability is orthogonal to intent: outages never consume a wake.
 */
import type { CaffyConfig } from "./CaffyScheduler.ts";
import type { VerifiedChatGPTIdleTransition } from "./ChatGPTIdleTransitionJournal.ts";
import type { DeliveryRecord, DeliveryState } from "./ChatGPTDeliveryQueue.ts";

export type CaffyWakePhase =
  | "paused" | "delayed" | "awaiting_idle" | "awaiting_response" | "awaiting_due" | "ready"
  | "awaiting_admission" | "queued" | "sending" | "uncertain"
  | "blocked" | "recovering" | "rebooting";

export function caffyWakePhase(row: CaffyConfig, now: number, delivery?: DeliveryState | null): CaffyWakePhase {
  // Uncertainty remains visible even while the user pauses new submissions.
  if (row.pendingMessageId && (delivery === "uncertain" || delivery === "sending"))
    return delivery;
  if (row.paused) return "paused";
  if (row.rebootOperationId) return "rebooting";
  if (row.pendingMessageId) return delivery === "needs_attention" ? "blocked" : "queued";
  if (row.beginAt != null && row.beginAt > now) return "delayed";
  if (row.availability === "recovering" || row.availability === "unmounted") return "recovering";
  if (row.lastError || row.availability === "unavailable") return "blocked";
  if (row.availability === "working") return "awaiting_response";
  if (row.pendingWake) return row.admissionReason ? "awaiting_admission" : "ready";
  if (row.mode === "idle") return "awaiting_idle";
  if (row.mode === "periodic") return "awaiting_due";
  return "awaiting_admission";
}

export type CaffyWakeEvent =
  | { type: "idle"; idle: VerifiedChatGPTIdleTransition; now: number }
  | { type: "due"; now: number }
  | { type: "claim"; messageId: string; body: string; now: number }
  | { type: "delivery"; receipt: Omit<DeliveryRecord, "body">; now: number };

export function reduceCaffyWake(
  row: Readonly<CaffyConfig>, event: CaffyWakeEvent,
): { patch: Partial<CaffyConfig>; requested: boolean } {
  const unchanged = { patch: {}, requested: false };
  if (event.type === "delivery") {
    const r = event.receipt;
    if (r.messageId !== row.pendingMessageId) return unchanged;
    const patch: Partial<CaffyConfig> = {
      deliveryStatus: r.status, lastDeliveryResult: r.lastError ?? r.status,
      deliveryUpdatedAt: r.updatedAt, deliveryAwaitingGuest: r.awaitingGuest ?? false,
    };
    if (r.status === "delivered") Object.assign(patch, {
      pendingMessageId: null, pendingMessageBody: null, delayedPrompt: null,
      runWithoutBusy: false, lastWakeAt: r.updatedAt,
      lastActivatedAt: row.lastActivatedAt ?? r.updatedAt, lastError: null,
      lastCheckResult: "Wake confirmed in the exact recipient; awaiting the next verified idle event.",
    });
    else if (r.status === "cancelled") {
      // Cancellation is not a durable T3 close. Unknown cancelled submissions
      // retain their receipt and require resolution, never an automatic replay.
      if (r.lastSubmissionAt || r.uncertainSince || /unknown|may have occurred/i.test(r.lastError ?? ""))
        patch.lastError = "Cancelled delivery may have been submitted; inspect its receipt before continuing.";
      else Object.assign(patch, {
        pendingMessageId: null, pendingMessageBody: null,
        lastError: r.lastError ?? "Wake cancelled before submission; schedule retained.",
      });
    } else if (r.status === "needs_attention") patch.lastError = r.lastError ?? "Delivery needs attention.";
    else patch.lastError = r.status === "uncertain"
      ? "Submission outcome unknown; read-only receipt reconciliation, no resend."
      : null;
    return { patch, requested: false };
  }
  if (row.paused || row.rebootOperationId || row.pendingMessageId ||
      (row.expiresAt !== null && row.expiresAt <= event.now) ||
      (row.beginAt != null && row.beginAt > event.now)) return unchanged;
  if (event.type === "claim") {
    if (!row.pendingWake) return unchanged;
    return { patch: {
      pendingMessageId: event.messageId, pendingMessageBody: event.body,
      delayedPrompt: null, pendingWake: false, pendingReason: null,
      deliveryStatus: "queued", deliveryAwaitingGuest: true,
      lastDeliveryResult: "Persisted receipt; awaiting verified recipient mount.",
      lastError: null,
    }, requested: false };
  }
  if (event.type === "due") {
    if (row.mode !== "periodic" || row.nextDueAt === null || row.nextDueAt > event.now)
      return unchanged;
    const interval = row.intervalMinutes * 60_000;
    return { patch: {
      nextDueAt: row.nextDueAt + (Math.floor((event.now - row.nextDueAt) / interval) + 1) * interval,
      pendingWake: true, pendingReason: "periodic",
      lastCheckResult: "Periodic deadline reached; wake requested.",
    }, requested: !row.pendingWake };
  }
  const idle = event.idle;
  if (idle.conversationId !== row.conversationId ||
      !Number.isSafeInteger(idle.sequence) || idle.sequence <= 0 ||
      !Number.isSafeInteger(idle.observedAt) || idle.observedAt > event.now + 60_000)
    return unchanged;
  const unseen = idle.sequence > row.lastIdleSequence;
  // One-time migration of an edge consumed by the old turn-count filter.
  const legacy = idle.sequence === row.lastIdleSequence &&
    row.lastHandledIdleEventId == null && row.lastWakeAt !== null &&
    idle.observedAt > row.lastWakeAt;
  if (!unseen && !legacy) return unchanged;
  const patch: Partial<CaffyConfig> = {
    lastIdleSequence: idle.sequence, lastHandledIdleTurnCount: idle.turnCount,
    lastHandledIdleEventId: idle.eventId,
  };
  const repeatedEvidence = idle.evidenceKey != null && idle.evidenceKey === row.lastIdleEvidenceKey;
  if (idle.evidenceKey) patch.lastIdleEvidenceKey = idle.evidenceKey;
  if ((row.mode === "idle" || row.mode === "queued") && !row.pendingWake &&
      !repeatedEvidence && idle.observedAt > (row.lastWakeAt ?? row.createdAt)) {
    Object.assign(patch, {
      pendingWake: true, pendingReason: "idle",
      lastCheckResult: `New verified ${idle.kind ?? "idle"} event #${idle.sequence}; wake requested.`,
    });
    return { patch, requested: true };
  }
  return { patch, requested: false };
}
