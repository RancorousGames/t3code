/**
 * Wake policy belongs to the durable T3 owner. This reducer owns trigger and
 * receipt transitions; the outbox alone owns submission (at-least-once).
 * Modes: "idle" (Keep running) wakes on every verified idle edge; "periodic"
 * (Interval) requests a wake when due, waits for idle, and restarts its
 * interval from the delivered wake. A pending wake always ends: delivered,
 * cancelled or gave up. The last two re-arm the wake, so Caffy never stalls.
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
      lastWakeAt: r.updatedAt,
      ...(row.mode === "periodic" ? { nextDueAt: r.updatedAt + row.intervalMinutes * 60_000 } : {}),
      lastActivatedAt: row.lastActivatedAt ?? r.updatedAt, lastError: null,
      lastCheckResult: "Wake confirmed in the exact recipient; awaiting the next verified idle event.",
    });
    else if (r.status === "cancelled" || r.status === "needs_attention") Object.assign(patch, {
      // The outbox gave up (and notified) or the send was cancelled. Never
      // stall: re-arm the wake so the next safe idle moment tries again.
      pendingMessageId: null, pendingMessageBody: null,
      pendingWake: true, pendingReason: row.pendingReason ?? (row.mode === "periodic" ? "periodic" : "idle"),
      lastError: r.lastError ?? (r.status === "cancelled"
        ? "Wake cancelled; retrying on the next opportunity."
        : "Wake delivery gave up; retrying on the next opportunity."),
    });
    else patch.lastError = null;
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
    // The interval restarts from the delivered wake, so the clock stops here.
    return { patch: {
      nextDueAt: null, pendingWake: true, pendingReason: "periodic",
      lastCheckResult: "Interval reached; waking once the session is idle.",
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
  if (row.mode === "idle" && !row.pendingWake &&
      !repeatedEvidence && idle.observedAt > (row.lastWakeAt ?? row.createdAt)) {
    Object.assign(patch, {
      pendingWake: true, pendingReason: "idle",
      lastCheckResult: `New verified ${idle.kind ?? "idle"} event #${idle.sequence}; wake requested.`,
    });
    return { patch, requested: true };
  }
  return { patch, requested: false };
}
