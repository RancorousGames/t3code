// A pending Caffy wake must never hold the schedule hostage: whatever happens
// to its delivery, the row ends up free to wake again.
import { expect, it } from "vite-plus/test";
import type { CaffyConfig } from "./CaffyScheduler.ts";
import { reduceCaffyWake } from "./CaffyWakeMachine.ts";

const MESSAGE = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;
const row = (mode: CaffyConfig["mode"]): CaffyConfig => ({
  sessionId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  mode, respectSlots: false, intervalMinutes: 5, startup: false, onceOnly: false, keepAwake: false, paused: false,
  createdAt: NOW - 100_000, expiresAt: null, nextDueAt: NOW + 60_000,
  pendingWake: false, pendingReason: null, pendingMessageId: MESSAGE,
  pendingMessageBody: "Continue", lastIdleSequence: 1, lastWakeAt: null, lastError: null,
});
const receipt = (status: "needs_attention" | "cancelled" | "uncertain" | "delivered") => ({
  messageId: MESSAGE, sessionId: "s", conversationId: "c", status, attempts: 9,
  createdAt: NOW - 3_600_000, updatedAt: NOW,
});

it("re-arms an idle-mode wake when delivery gives up", () => {
  const { patch } = reduceCaffyWake(row("idle"), { type: "delivery", receipt: receipt("needs_attention"), now: NOW });
  expect(patch).toMatchObject({ pendingMessageId: null, pendingWake: true });
});

it("re-arms an interval wake on give-up", () => {
  const { patch } = reduceCaffyWake(row("periodic"), { type: "delivery", receipt: receipt("needs_attention"), now: NOW });
  expect(patch).toMatchObject({ pendingMessageId: null, pendingWake: true });
});

it("pauses the interval clock when due and restarts it from the delivered wake", () => {
  const due = reduceCaffyWake({ ...row("periodic"), pendingMessageId: null, nextDueAt: NOW - 1 },
    { type: "due", now: NOW });
  expect(due.patch).toMatchObject({ nextDueAt: null, pendingWake: true });
  const delivered = { ...receipt("needs_attention"), status: "delivered" as const, updatedAt: NOW + 600_000 };
  const { patch } = reduceCaffyWake(row("periodic"), { type: "delivery", receipt: delivered, now: NOW + 600_000 });
  expect(patch.nextDueAt).toBe(NOW + 600_000 + 5 * 60_000);
});

it("frees the row on cancellation, even if the wake may have been sent", () => {
  const { patch } = reduceCaffyWake(row("idle"), { type: "delivery", receipt: receipt("cancelled"), now: NOW });
  expect(patch.pendingMessageId).toBeNull();
});

it("keeps the pending wake while the outbox is still retrying", () => {
  const { patch } = reduceCaffyWake(row("idle"), { type: "delivery", receipt: receipt("uncertain"), now: NOW });
  expect(patch.pendingMessageId).toBeUndefined();
  expect(patch.lastError).toBeNull();
});
