// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Isolated durable scheduler/outbox recovery fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { CaffyScheduler, type CaffyConfig } from "./CaffyScheduler.ts";
import { ChatGPTDeliveryQueue } from "./ChatGPTDeliveryQueue.ts";
import { reduceCaffyWake } from "./CaffyWakeMachine.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;

function fixture(status: "queued" | "uncertain") {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caffy-recovery-"));
  const row: CaffyConfig = {
    sessionId: SESSION, conversationId: OLD, mode: "idle", intervalMinutes: 20,
    startup: false, onceOnly: false, keepAwake: false, paused: false,
    createdAt: NOW - 100_000, expiresAt: null, nextDueAt: null,
    pendingWake: false, pendingReason: null, pendingMessageId: MESSAGE,
    pendingMessageBody: "Continue", lastIdleSequence: 61, lastWakeAt: NOW - 60_000,
    lastError: null,
  };
  NodeFS.writeFileSync(NodePath.join(directory, "caffy-v2.json"), JSON.stringify({
    version: 2, entries: [row], keepT3Busy: false, maxWorking: 1,
  }));
  NodeFS.writeFileSync(NodePath.join(directory, "chatgpt-deliveries-v1.json"), JSON.stringify([{
    messageId: MESSAGE, sessionId: SESSION, conversationId: OLD,
    body: "Continue", caffyWake: true, status, attempts: status === "queued" ? 0 : 1,
    createdAt: NOW - 1_000, updatedAt: NOW - 1_000,
  }]));
  const request: ConstructorParameters<typeof ChatGPTDeliveryQueue>[1] = async input => ({
    version: 1, requestId: input.requestId, ok: true, data: {
      sessions: [{ id: SESSION, conversationId: NEW,
        bootstrapIdentity: { state: "registered", publicId: SESSION, conversationId: NEW } }],
      total: 1,
    },
  });
  const queue = new ChatGPTDeliveryQueue(directory, request);
  const scheduler = new CaffyScheduler(directory, queue, request, { start: () => 0, stop: () => {} });
  return { directory, scheduler, queue, [Symbol.dispose]() {
    scheduler.close(); queue.close(); NodeFS.rmSync(directory, { recursive: true, force: true });
  } };
}

it("retains an uncertain receipt across conversation migration and desktop restart", async () => {
  using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  using f = fixture("uncertain");
  await f.scheduler.reconcileIdentityAliases(true);
  expect(f.scheduler.status(SESSION)).toMatchObject({
    sessionId: SESSION, pendingMessageId: MESSAGE, paused: false,
  });
  expect(f.queue.status(MESSAGE).status).toBe("uncertain");
  const restartedQueue = new ChatGPTDeliveryQueue(f.directory, async () => { throw new Error("No sends"); });
  const restarted = new CaffyScheduler(f.directory, restartedQueue,
    async () => { throw new Error("Renderer unavailable"); }, { start: () => 0, stop: () => {} });
  try {
    await restarted.reconcileIdentityAliases(true);
    expect(restarted.status(SESSION)).toMatchObject({ pendingMessageId: MESSAGE });
    expect(restartedQueue.status(MESSAGE).status).toBe("uncertain");
  } finally { restarted.close(); restartedQueue.close(); }
});

it("retargets a proven unsent wake without losing its intent or deleting the T3 monitor", async () => {
  using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  using f = fixture("queued");
  await f.scheduler.reconcileIdentityAliases(true);
  expect(f.scheduler.status(SESSION)).toMatchObject({
    sessionId: SESSION, conversationId: NEW, pendingWake: true, pendingMessageId: null,
  });
  expect(f.queue.status(MESSAGE).status).toBe("cancelled");
});

it.each(["idle", "periodic"] as const)("recovers %s intent after restart and never resends an ambiguous receipt", async mode => {
  let now = NOW;
  using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  using f = fixture("queued");
  f.scheduler.close();
  f.queue.close();
  const storePath = NodePath.join(f.directory, "caffy-v2.json");
  const store = JSON.parse(NodeFS.readFileSync(storePath, "utf8"));
  Object.assign(store.entries[0], { mode, pendingMessageId: null, pendingMessageBody: null,
    lastHandledIdleTurnCount: 5, nextDueAt: mode === "periodic" ? NOW - 25 * 60_000 : null });
  NodeFS.writeFileSync(storePath, JSON.stringify(store));
  NodeFS.writeFileSync(NodePath.join(f.directory, "chatgpt-deliveries-v1.json"), "[]");
  const calls: string[] = [];
  const sender: ConstructorParameters<typeof ChatGPTDeliveryQueue>[1] = async request => {
    if (request.type !== "chatgpt.sessions") throw new Error("Unexpected request");
    if (request.action === "list") return { version: 1, requestId: request.requestId, ok: true,
      data: { sessions: [{ id: SESSION, conversationId: OLD, activity: "idle" }], total: 1 } };
    calls.push(request.action);
    expect(request.expectedConversationId).toBe(OLD);
    expect(request.message).toContain("[T3-MSG:");
    return { version: 1, requestId: request.requestId, ok: false, code: "request-timeout",
      message: "The desktop app did not receive or complete the queued request in time" };
  };
  let queue = new ChatGPTDeliveryQueue(f.directory, sender);
  let scheduler = new CaffyScheduler(f.directory, queue, sender, { start: () => 0, stop: () => {} });
  const idle = { environmentId: "local", sessionId: SESSION, conversationId: OLD,
    sequence: 61, eventId: `${SESSION}:${OLD}:61`, observedAt: NOW - 5000,
    turnCount: 4, bindingRevision: null, kind: "quiescent" as const };
  scheduler.setLatestIdleSource(() => idle);
  const pump = async () => {
    const internal = scheduler as unknown as { started: boolean; pump(): Promise<void> };
    internal.started = true;
    await internal.pump();
  };
  try {
    // Idle is independent of Busy/capacity. Periodic uses explicit admission.
    scheduler.reportWorkingSnapshot([], "test");
    scheduler.setTaskReservations([], true);
    await pump();
    const pending = scheduler.status(SESSION) as CaffyConfig;
    expect(pending.pendingMessageId).toBeTruthy();
    if (mode === "periodic") expect(pending.nextDueAt).toBe(NOW + 15 * 60_000);
    else expect(pending.nextDueAt).toBeNull();
    const messageId = pending.pendingMessageId!;
    expect(calls).toEqual([]); // Queued is not delivered, mount is still required.
    const uncertain = new Promise<void>(resolve => queue.subscribeTransitions(r => {
      if (r.messageId === messageId && r.status === "uncertain") resolve();
    }));
    queue.start();
    queue.onRecipientMounted({ sessionId: SESSION, conversationId: OLD });
    await uncertain;
    expect(calls).toEqual(["send"]);
    expect(scheduler.status(SESSION)).toMatchObject({ pendingMessageId: messageId, wakePhase: "uncertain" });
    scheduler.close(); queue.close();
    now += 60 * 60_000;
    queue = new ChatGPTDeliveryQueue(f.directory, sender);
    scheduler = new CaffyScheduler(f.directory, queue, sender, { start: () => 0, stop: () => {} });
    scheduler.setLatestIdleSource(() => idle);
    await pump();
    await queue.pulse();
    expect(calls).toEqual(["send", "reconcile_send"]);
    expect(queue.list()).toHaveLength(1);
    expect(scheduler.status(SESSION)).toMatchObject({ pendingMessageId: messageId, wakePhase: "uncertain" });
  } finally { scheduler.close(); queue.close(); }
});

it("keeps periodic and idle triggers distinct through pauses, delays and duplicate edges", () => {
  using f = fixture("queued");
  const row = { ...(f.scheduler.status(SESSION) as CaffyConfig), pendingMessageId: null };
  expect(reduceCaffyWake(row, { type: "due", now: NOW }).requested).toBe(false);
  row.mode = "periodic"; row.nextDueAt = NOW - 1;
  expect(reduceCaffyWake({ ...row, paused: true }, { type: "due", now: NOW }).requested).toBe(false);
  expect(reduceCaffyWake({ ...row, beginAt: NOW + 1 }, { type: "due", now: NOW }).requested).toBe(false);
  const due = reduceCaffyWake(row, { type: "due", now: NOW });
  expect(due.requested).toBe(true);
  expect(reduceCaffyWake({ ...row, ...due.patch }, { type: "due", now: NOW }).requested).toBe(false);
});
