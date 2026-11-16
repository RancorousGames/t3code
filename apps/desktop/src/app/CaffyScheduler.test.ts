// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Disposable filesystem-based scheduler persistence fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CaffyScheduler, legacyMonitorOwnsConversation, type CaffyConfig } from "./CaffyScheduler.ts";
import type { VerifiedChatGPTIdleTransition } from "./ChatGPTIdleTransitionJournal.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ORIGINAL = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT = "33333333-3333-4333-8333-333333333333";
const WAKE = "44444444-4444-4444-8444-444444444444";

const makeConfig = (): CaffyConfig => ({
  sessionId: SESSION,
  publicSessionId: SESSION,
  conversationId: ORIGINAL,
  mode: "idle",
  respectSlots: false,
  intervalMinutes: 20,
  startup: false,
  onceOnly: false,
  keepAwake: false,
  paused: false,
  createdAt: Date.now(),
  expiresAt: null,
  nextDueAt: null,
  pendingWake: true,
  pendingReason: "manual",
  pendingMessageId: WAKE,
  lastIdleSequence: 1,
  lastWakeAt: null,
  lastError: null,
  beginAt: Date.now() + 3_600_000,
  autoRebootMinutes: 60,
});

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-caffy-persist-"));
  const initial = makeConfig();
  NodeFS.writeFileSync(NodePath.join(directory, "caffy-v2.json"), JSON.stringify({
    version: 2, entries: [initial], keepT3Busy: true, maxWorking: 3,
  }));
  let roster: Array<{
    id: string; conversationId: string; bootstrapIdentity: {
      state: string; publicId: string; conversationId: string;
    }; hidden?: boolean; snoozedUntil?: number; status?: string; activity?: string; statusObservedAt?: string;
    lastRole?: string; binding?: {boundAt?: string};
    lastIdleTransition?: {conversationId: string; sequence: number};
  }> = [];
  let guardedRead = false;
  let idleReadStatus = "done_or_idle";
  let idleReadRole: "assistant" | "user" = "assistant";
  let idleReadTurns = 3;
  let lastIdle: VerifiedChatGPTIdleTransition | null = null;
  let retirementCount = 0;
  let onDelivery: ((record: {
    sessionId: string; conversationId: string; status: "cancelled"; messageId: string;
  }) => void) | null = null;
  const deliveries = {
    subscribeTransitions: (listener: typeof onDelivery) => { onDelivery = listener; return () => {}; },
    setDispatchPermission: () => {},
    setDispatchAdmission: () => {},
    resumeAllowed: () => {},
    status: () => ({messageId: WAKE, sessionId: SESSION, conversationId: ORIGINAL,
      status: "queued", attempts: 0, updatedAt: Date.now()}),
    cancel: () => {
      retirementCount++;
      onDelivery?.({ sessionId: SESSION, conversationId: ORIGINAL, status: "cancelled", messageId: WAKE });
    },
    retireRecipient: () => {
      retirementCount++;
      onDelivery?.({ sessionId: SESSION, conversationId: ORIGINAL, status: "cancelled", messageId: WAKE });
      return 1;
    },
  } as unknown as ConstructorParameters<typeof CaffyScheduler>[1];
  const request = (async (input: { requestId: string; type?: string; action?: string }) => ({
    version: 1,
    requestId: input.requestId,
    ok: true,
    data: input.type === "chatgpt.spawn"
      ? { sessionId: REPLACEMENT }
      : input.action === "read"
        ? { conversationGuardValidated: guardedRead,
            verifiedConversationId: guardedRead ? (roster[0]?.conversationId ?? REPLACEMENT) : REPLACEMENT,
            session: {conversationId: roster[0]?.conversationId ?? REPLACEMENT,
              status: idleReadStatus, activity: "idle", lastRole: idleReadRole,
              totalTurns: idleReadTurns} }
        : { sessions: roster, total: roster.length },
  })) as ConstructorParameters<typeof CaffyScheduler>[2];
  const open = (shutdownPC: () => void = () => { throw new Error("Never call OS shutdown in tests."); }) => {
    const c = new CaffyScheduler(directory, deliveries, request, {
      start: () => 1, stop: () => {},
    }, shutdownPC);
    c.setLatestIdleSource(() => lastIdle);
    return c;
  };
  return {
    initial, open,
    setRoster: (rows: typeof roster) => { roster = rows; },
    verifyRead: () => { guardedRead = true; },
    setReadStatus: (status: string) => { idleReadStatus = status; },
    setReadRole: (role: "assistant" | "user") => { idleReadRole = role; },
    setReadTurns: (turns: number) => { idleReadTurns = turns; },
    setLatestIdle: (event: VerifiedChatGPTIdleTransition | null) => { lastIdle = event; },
    retired: () => retirementCount,
    dispose: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
    directory,
  };
}

const monitor = (scheduler: CaffyScheduler) =>
  (scheduler as unknown as { entries: Map<string, CaffyConfig> }).entries.get(SESSION) ?? null;

describe("Caffy settings survive T3 restart and session lifecycle recovery", () => {
  it("runs user-scheduled work at free capacity with TaskBoard autofill off", async () => {
    const f = fixture();
    const c = f.open();
    try {
      monitor(c)!.pendingMessageId = null;
      monitor(c)!.pendingWake = false;
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations([], true);
      c.policy({ keepT3Busy: false, maxWorking: 2 });
      expect(c.policyEnabled).toBe(false);
      // This switch still blocks TaskBoard-initiated work.
      expect(await c.acquireAutomaticAdmission("taskboard:next")).toBe(false);
      // One-shot and periodic session wakes use the same capacity threshold.
      expect(await c.acquireAutomaticAdmission("wake:queued", SESSION, true)).toBe(true);
      c.releaseAutomaticAdmission("wake:queued");
    } finally { c.close(); f.dispose(); }

    const g = fixture();
    const scheduler = g.open();
    try {
      monitor(scheduler)!.pendingMessageId = null;
      monitor(scheduler)!.pendingWake = false;
      scheduler.reportWorkingSnapshot([], "sidebar");
      scheduler.setTaskReservations([], true);
      scheduler.policy({ keepT3Busy: false, maxWorking: 2 });
      const jobId = "55555555-5555-4555-8555-555555555555";
      scheduler.scheduleSpawn({ id: jobId, title: "Daily report",
        prompt: "Produce today’s status report", beginAt: null, onIdle: true });
      await (scheduler as unknown as {dispatchScheduledSpawn(now: number): Promise<void>})
        .dispatchScheduledSpawn(Date.now());
      expect(scheduler.status()).toMatchObject({
        keepT3Busy: false,
        scheduledSpawns: [{id: jobId, status: "created", sessionId: REPLACEMENT}],
      });
    } finally { scheduler.close(); g.dispose(); }
  });
  it("attaches Caffy to a scheduled new session after its conversation is verified", async () => {
    const f = fixture();
    const c = f.open();
    try {
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations([], true);
      const jobId = "55555555-5555-4555-8555-555555555555";
      c.scheduleSpawn({
        id: jobId, title: "New recurring worker", prompt: "Start the assignment",
        beginAt: null, onIdle: true,
        caffy: { mode: "idle", intervalMinutes: 20, respectSlots: false,
          repeatPrompt: "Continue the assignment" },
      });
      await (c as unknown as {dispatchScheduledSpawn(now: number): Promise<void>})
        .dispatchScheduledSpawn(Date.now());
      expect(c.status(REPLACEMENT)).toBeNull();
      f.setRoster([{
        id: REPLACEMENT, conversationId: SESSION,
        bootstrapIdentity: {state: "registered", publicId: REPLACEMENT, conversationId: SESSION},
      }]);
      await (c as unknown as {activateCreatedSpawnCaffy(): Promise<void>})
        .activateCreatedSpawnCaffy();
      expect(c.status(REPLACEMENT)).toMatchObject({
        mode: "idle", repeatPrompt: "Continue the assignment",
        pendingWake: true, onceOnly: false,
      });
      const status = c.status() as { scheduledSpawns: Array<{caffyAppliedAt?: number}> };
      expect(status.scheduledSpawns[0]?.caffyAppliedAt).toBeTypeOf("number");
    } finally { c.close(); f.dispose(); }
  });

  it("starts an idle-mode monitor immediately only with a verified idle guest", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.mode = "periodic";
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
      }]);
      f.verifyRead();
      const ready = await c.set({ sessionId: SESSION, conversationId: ORIGINAL, mode: "idle" });
      expect(ready).toMatchObject({ pendingWake: true, pendingReason: "manual" });
      ready.pendingWake = false;
      const again = await c.set({ sessionId: SESSION, conversationId: ORIGINAL, mode: "idle" });
      expect(again.pendingWake).toBe(true); // repair an old never-woken idle schedule
      again.pendingWake = false;
      again.lastWakeAt = Date.now();
      const stable = await c.set({ sessionId: SESSION, conversationId: ORIGINAL, mode: "idle" });
      expect(stable.pendingWake).toBe(false); // already delivered: do not re-wake on identical set
      again.paused = true;
      const resumed = await c.set({ sessionId: SESSION, conversationId: ORIGINAL, mode: "idle" });
      expect(resumed).toMatchObject({ paused: false, pendingWake: true });
      const audit = NodeFS.readFileSync(NodePath.join(f.directory, "caffy-state-transitions.ndjson"), "utf8")
        .trim().split("\n").map(line => JSON.parse(line) as {event: string; cause: string});
      expect(audit.at(-1)).toMatchObject({event: "resumed", cause: "set:identical-config"});
      resumed.pendingWake = false;
      resumed.mode = "periodic";
      f.setReadStatus("pending_or_stalled");
      const unfinished = await c.set({ sessionId: SESSION, conversationId: ORIGINAL, mode: "idle" });
      expect(unfinished.pendingWake).toBe(true); // newly enabled idle Caffy queues a guarded continuation
    } finally { c.close(); f.dispose(); }
  });

  it("replays only a missed, verified idle transition after renderer recovery", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        // No renderer idle cache: this simulates a hibernated guest after restart.
      }]);
      f.setLatestIdle({
        environmentId: "local", sessionId: SESSION, conversationId: ORIGINAL,
        bindingRevision: null, sequence: 2, eventId: `${SESSION}:${ORIGINAL}:2`,
        observedAt: Date.now(), turnCount: 3, kind: "completed",
      });
      await c.reconcileIdentityAliases(true);
      expect(row).toMatchObject({lastIdleSequence: 2, pendingWake: true, pendingReason: "idle"});
      row.pendingWake = false;
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // no duplicate continuation
      row.lastIdleSequence = 2;
      f.setLatestIdle({
        environmentId: "local", sessionId: SESSION, conversationId: REPLACEMENT,
        bindingRevision: null, sequence: 3, eventId: `${SESSION}:${REPLACEMENT}:3`,
        observedAt: Date.now(), turnCount: 1, kind: "completed",
      });
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // wrong conversation cannot authorize delivery
    } finally { c.close(); f.dispose(); }
  });

  it("rechecks already-idle assistants after restart even if the idle sequence was consumed", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      row.lastIdleSequence = 52; // The journal edge was consumed before T3 restarted.
      row.lastWakeAt = Date.now() - 90_000;
      const repliedAt = new Date(Date.now() - 30_000).toISOString();
      f.setLatestIdle({
        environmentId: "local", sessionId: SESSION, conversationId: ORIGINAL,
        bindingRevision: null, sequence: 52, eventId: `${SESSION}:${ORIGINAL}:52`,
        observedAt: Date.now() - 30_000, turnCount: 3, kind: "completed",
      });
      row.lastHandledIdleTurnCount = 3;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "done_or_idle", activity: "idle", lastRole: "assistant",
        statusObservedAt: repliedAt,
        lastIdleTransition: {conversationId: ORIGINAL, sequence: 52},
      }]);
      f.verifyRead();
      await c.reconcileIdentityAliases(true);
      expect(row).toMatchObject({
        lastIdleSequence: 52, pendingWake: true, pendingReason: "idle",
      });
      // After sending the continuation, the same idle state cannot trigger it again.
      row.pendingWake = false;
      row.lastWakeAt = Date.now();
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false);
    } finally { c.close(); f.dispose(); }
  });

  it("honors a fresh quiescent idle event even if DOM turn count decreased", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.beginAt = null;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.lastIdleSequence = 60;
      row.lastHandledIdleTurnCount = 5;
      row.lastWakeAt = Date.now() - 60_000;
      const event: VerifiedChatGPTIdleTransition = {
        environmentId: "local", sessionId: SESSION, conversationId: ORIGINAL,
        bindingRevision: null, sequence: 61, eventId: `${SESSION}:${ORIGINAL}:61`,
        observedAt: Date.now() - 5_000, turnCount: 4, kind: "quiescent",
      };
      c.onIdle(event);
      expect(row.pendingWake).toBe(true);
      expect(row.lastIdleSequence).toBe(61);
      expect(row.lastHandledIdleTurnCount).toBe(4);
      expect(row.lastCheckResult).toContain("quiescent event #61");
      row.pendingWake = false;
      c.onIdle(event);
      expect(row.pendingWake).toBe(false); // Same event sequence cannot wake again.
      row.lastWakeAt = Date.now();
      c.onIdle({...event, sequence: 62, eventId: `${SESSION}:${ORIGINAL}:62`});
      expect(row.pendingWake).toBe(false); // Older observation than delivered wake.
    } finally { c.close(); f.dispose(); }
  });

  it("reconciles a previously consumed quiescent edge despite lower turn count", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.beginAt = null;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.lastIdleSequence = 61;
      row.lastHandledIdleTurnCount = 5;
      row.lastWakeAt = Date.now() - 60_000;
      f.setLatestIdle({
        environmentId: "local", sessionId: SESSION, conversationId: ORIGINAL,
        bindingRevision: null, sequence: 61, eventId: `${SESSION}:${ORIGINAL}:61`,
        observedAt: Date.now() - 5_000, turnCount: 4, kind: "quiescent",
      });
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "pending_or_stalled", activity: "idle", lastRole: "user",
        statusObservedAt: new Date().toISOString(),
        lastIdleTransition: {conversationId: ORIGINAL, sequence: 61},
      }]);
      f.verifyRead();
      f.setReadStatus("pending_or_stalled");
      f.setReadRole("user");
      f.setReadTurns(4);
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(true);
      expect(row.lastCheckResult).toContain("wake requested");
      row.pendingWake = false;
      row.lastWakeAt = Date.now();
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false);
    } finally { c.close(); f.dispose(); }
  });

  it("reports why the idle monitor has not fired after a scheduler check", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.beginAt = null;
      row.pendingMessageId = null;
      row.pendingWake = false;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "pending_or_stalled", activity: "idle", lastRole: "user",
        statusObservedAt: new Date().toISOString(),
      }]);
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false);
      expect(row.lastCheckedAt).toBeGreaterThan(0);
      expect(row.lastCheckResult).toContain("waiting for verified quiescence");
    } finally { c.close(); f.dispose(); }
  });

  it("refuses startup idle recovery without newer verified assistant completion", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      row.lastWakeAt = Date.now() - 30_000;
      row.lastHandledIdleTurnCount = 3;
      const oldStatus = new Date(Date.now() - 60_000).toISOString();
      const base = {
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "done_or_idle", activity: "idle",
      };
      f.verifyRead();
      f.setRoster([{...base, lastRole: "assistant", statusObservedAt: oldStatus}]);
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // Same assistant turn was already handled.
      const recent = new Date(Date.now()).toISOString();
      f.setRoster([{...base, lastRole: "user", statusObservedAt: recent}]);
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // Unanswered prompt is not a completed run.
      f.setRoster([{...base, lastRole: "assistant", statusObservedAt: recent}]);
      f.setReadTurns(4);
      f.setReadStatus("pending_or_stalled");
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // Stale roster cannot override a live read.
      f.setReadStatus("done_or_idle");
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // A count is not a verified event, even when it increases.
      expect(row.lastHandledIdleTurnCount).toBe(3);
      row.pendingWake = false;
      await c.reconcileIdentityAliases(true);
      expect(row.pendingWake).toBe(false); // Same turn cannot trigger twice.
    } finally { c.close(); f.dispose(); }
  });

  it("always arms a new resume-on-idle schedule even when an API caller supplies wakeNow=false", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.mode = "periodic";
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
      }]);
      f.setLatestIdle({
        environmentId: "local", sessionId: SESSION, conversationId: ORIGINAL,
        bindingRevision: null, sequence: 3, eventId: `${SESSION}:${ORIGINAL}:3`,
        observedAt: Date.now(), turnCount: 3, kind: "completed",
      });
      const scheduled = await c.set({sessionId: SESSION, conversationId: ORIGINAL,
        mode: "idle", wakeNow: false});
      expect(scheduled).toMatchObject({pendingWake: true, pendingReason: "manual", lastIdleSequence: 3});
      await c.reconcileIdentityAliases(true);
      expect(scheduled.pendingWake).toBe(true);
    } finally { c.close(); f.dispose(); }
  });

  it("arms an idle Caffy even when the last observed turn was user-only", async () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.mode = "periodic";
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        activity: "idle", status: "done_or_idle", lastRole: "user",
      }]);
      const scheduled = await c.set({
        sessionId: SESSION, conversationId: ORIGINAL, mode: "idle", wakeNow: false,
      });
      expect(scheduled).toMatchObject({pendingWake: true, pendingReason: "manual"});
    } finally { c.close(); f.dispose(); }
  });

  it("repairs a never-woken resume-on-idle monitor on the next T3 startup", () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.mode = "idle";
      row.beginAt = null;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.lastWakeAt = null;
      // The test targets startup policy, not the asynchronous delivery pump.
      (c as unknown as {pump: () => Promise<void>}).pump = async () => {};
      c.start();
      expect(row).toMatchObject({pendingWake: true, pendingReason: "manual"});
    } finally { c.close(); f.dispose(); }
  });

  it("re-arms resume-on-idle when a paused monitor is resumed by command", () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.mode = "idle";
      row.paused = true;
      row.pendingMessageId = null;
      row.pendingWake = false;
      row.beginAt = null;
      c.pause(SESSION, false);
      expect(row).toMatchObject({paused: false, pendingWake: true, pendingReason: "manual"});
    } finally { c.close(); f.dispose(); }
  });

  it("rejects live legacy ownership but ignores stale terminal OmniHub monitors", () => {
    const old = { state: "active", target: { sessionId: SESSION, expectedConversationId: ORIGINAL } };
    expect(legacyMonitorOwnsConversation(old, SESSION, ORIGINAL)).toBe(true);
    expect(legacyMonitorOwnsConversation({ ...old, state: "paused_indeterminate" }, SESSION, ORIGINAL))
      .toBe(true);
    for (const state of ["cancelled", "canceled", "completed", "exhausted",
      "mandate_finished", "blocked", "expired", "failed"]) {
      expect(legacyMonitorOwnsConversation({ ...old, state }, SESSION, ORIGINAL)).toBe(false);
    }
  });
  it("lists pending sessions without exposing prompts, and edits or cancels the same durable job", () => {
    const f = fixture();
    const c = f.open();
    const jobId = "77777777-7777-4777-8777-777777777777";
    try {
      c.scheduleSpawn({ id: jobId, title: "Status report", prompt: "Report today's status",
        beginAt: null, onIdle: true });
      const overview = c.status() as { scheduledSpawns: Array<Record<string, unknown>> };
      expect(overview.scheduledSpawns[0]).toMatchObject({
        id: jobId, title: "Status report", beginAt: null, onIdle: true, status: "scheduled",
      });
      expect(overview.scheduledSpawns[0]).not.toHaveProperty("prompt");
      expect(c.readScheduledSpawn(jobId).prompt).toBe("Report today's status");

      const start = Date.now() + 60 * 60_000;
      c.updateScheduledSpawn({ id: jobId, title: "Weekly report",
        prompt: "Report on the last 7 days", beginAt: start, onIdle: false });
      expect(c.readScheduledSpawn(jobId)).toMatchObject({
        id: jobId, title: "Weekly report", prompt: "Report on the last 7 days",
        beginAt: start, onIdle: false,
      });
      c.close();
      const restored = f.open();
      try {
        expect(restored.readScheduledSpawn(jobId).prompt).toBe("Report on the last 7 days");
        expect(restored.cancelScheduledSpawn(jobId)).toMatchObject({ cancelled: true, id: jobId });
        expect(() => restored.readScheduledSpawn(jobId)).toThrow("not found");
      } finally { restored.close(); }
    } finally { c.close(); f.dispose(); }
  });
  it("counts only verified completed runs and retains a single periodic wake through restart", () => {
    const f = fixture();
    const c = f.open();
    try {
      const row = monitor(c)!;
      row.mode = "periodic";
      row.respectSlots = true;
      row.intervalMinutes = 10080;
      row.beginAt = null;
      row.nextDueAt = Date.now() + 10080 * 60_000;
      row.pendingWake = true;
      row.pendingMessageId = null;
      row.lastWakeAt = Date.now() - 5_000;
      row.repeatPrompt = "Generate the weekly project report.";
      row.autoRebootEveryRuns = 3;
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations([], true);
      expect(c.hasPendingQueuedWakes).toBe(true);

      const completed = {
        environmentId: "local", sessionId: SESSION, conversationId: ORIGINAL,
        bindingRevision: null, sequence: 2, eventId: `${SESSION}:${ORIGINAL}:2`,
        observedAt: Date.now(), turnCount: 3, kind: "completed" as const,
      };
      c.onIdle(completed);
      c.onIdle(completed);
      expect(row.wakesSinceReboot).toBe(1);
      expect(row.pendingWake).toBe(true);
      c.close();

      const restored = f.open();
      try {
        expect(monitor(restored)).toMatchObject({
          mode: "periodic", intervalMinutes: 10080, pendingWake: true,
          repeatPrompt: "Generate the weekly project report.",
          autoRebootEveryRuns: 3, wakesSinceReboot: 1,
        });
      } finally { restored.close(); }
    } finally { c.close(); f.dispose(); }
  });
  it("persists timed Busy, disarms on manual override, and rejects new work after expiration", async () => {
    const f = fixture();
    const first = f.open();
    try {
      const timed = first.policy({ busyForMinutes: 120 });
      expect(timed).toMatchObject({ keepT3Busy: true, shutdownWhenIdle: true });
      expect(timed.busyUntil).toBeGreaterThan(Date.now() + 119 * 60_000);
      first.close();
      const restored = f.open();
      try {
        expect(restored.status()).toMatchObject({ busyUntil: timed.busyUntil, keepT3Busy: true });
        restored.policy({ keepT3Busy: false });
        expect(restored.status()).toMatchObject({ busyUntil: null, keepT3Busy: false, shutdownWhenIdle: false });
      } finally { restored.close(); }
      const path = NodePath.join(f.directory, "caffy-v2.json");
      const expired = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      expired.keepT3Busy = true;
      expired.shutdownWhenIdle = true;
      expired.busyUntil = Date.now() - 1_000;
      NodeFS.writeFileSync(path, JSON.stringify(expired));
      const resumed = f.open();
      try {
        expect(resumed.status()).toMatchObject({ busyUntil: null, keepT3Busy: false, shutdownWhenIdle: true });
        expect(await resumed.acquireAutomaticAdmission("new-job")).toBe(false);
      } finally { resumed.close(); }
    } finally { first.close(); f.dispose(); }
  });
  it("holds shutdown until the timed window expires and existing work is idle", async () => {
    const f = fixture();
    let shutdowns = 0;
    const c = f.open(() => { shutdowns++; });
    const internal = c as unknown as {
      checkShutdown: () => Promise<void>;
      busyUntil: number | null;
      shutdownIdleSince: number | null;
    };
    try {
      monitor(c)!.pendingMessageId = null;
      monitor(c)!.pendingWake = false;
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations([], true);
      c.policy({ busyForMinutes: 60 });
      c.start();
      await internal.checkShutdown();
      expect(shutdowns).toBe(0);
      expect(internal.shutdownIdleSince).toBeNull();
      internal.busyUntil = Date.now() - 1;
      c.reportWorkingSnapshot([SESSION], "sidebar");
      await internal.checkShutdown();
      expect(shutdowns).toBe(0);
      c.reportWorkingSnapshot([], "sidebar");
      await internal.checkShutdown();
      expect(shutdowns).toBe(0);
      internal.shutdownIdleSince = Date.now() - 31_000;
      await internal.checkShutdown();
      expect(shutdowns).toBe(0);
      internal.shutdownIdleSince = Date.now() - 5 * 60_000 - 1;
      await internal.checkShutdown();
      expect(shutdowns).toBe(1);
      expect(c.status()).toMatchObject({ keepT3Busy: false, shutdownWhenIdle: false, busyUntil: null });
    } finally { c.close(); f.dispose(); }
  });
  it("reports exactly the green sidebar count while separately guarding a pending start", async () => {
    const f = fixture();
    const c = f.open();
    try {
      c.reportWorkingSnapshot([SESSION, ORIGINAL], "browser");
      c.setTaskReservations([{ requestId: WAKE, sessionId: null, holdUntil: Date.now() + 60_000 }]);
      const held = await c.capacity();
      expect(held).toMatchObject({ limit: 3, working: 2, reserved: 1, used: 2, available: 1, admissible: false });
      c.setTaskReservations([{ requestId: WAKE, sessionId: null, holdUntil: Date.now() - 1 }]);
      const expired = await c.capacity();
      expect(expired).toMatchObject({ limit: 3, working: 2, reserved: 0, used: 2, available: 1, admissible: true });
    } finally { c.close(); f.dispose(); }
  });
  it("ignores registry working signals and ten stale TaskBoard claims when the sidebar has no green sessions", async () => {
    const f = fixture();
    const c = f.open();
    try {
      monitor(c)!.pendingMessageId = null;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "working", activity: "working", statusObservedAt: new Date().toISOString(),
      }]);
      c.policy({keepT3Busy: true, maxWorking: 2});
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations(Array.from({length: 10}, (_, i) => ({
        requestId: `stale-${i}`, sessionId: `old-worker-${i}`,
      })), true);
      expect(await c.capacity()).toMatchObject({
        working: 0, workingIds: [], used: 0, reserved: 0, available: 2,
        admissible: true,
      });
      expect(await c.acquireAutomaticAdmission("fresh-task")).toBe(true);
      c.releaseAutomaticAdmission("fresh-task");
    } finally { c.close(); f.dispose(); }
  });
  it("counts sidebar green workers as authoritative even when an old registry snapshot says idle", async () => {
    const f = fixture();
    const c = f.open();
    try {
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "done_or_idle", activity: "idle", statusObservedAt: new Date().toISOString(),
      }]);
      c.setTaskReservations([], true);
      c.reportWorkingSnapshot([SESSION], "sidebar");
      expect(await c.capacity()).toMatchObject({
        working: 1, workingIds: [SESSION], reserved: 0, used: 1,
      });
    } finally { c.close(); f.dispose(); }
  });
  it("ignores stale Working ownership but separately guards a genuinely pending startup", async () => {
    const f = fixture();
    const c = f.open();
    try {
      monitor(c)!.pendingMessageId = null;
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
        status: "done_or_idle", activity: "idle", statusObservedAt: new Date().toISOString(),
        lastRole: "assistant", binding: {boundAt: new Date(Date.now() - 60_000).toISOString()},
      }]);
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations([{requestId: WAKE, sessionId: SESSION}], true);
      expect(await c.capacity()).toMatchObject({working: 0, reserved: 0, used: 0, available: 3});
      c.setTaskReservations([{requestId: WAKE, sessionId: SESSION,
        holdUntil: Date.now() + 90_000}], true);
      expect(await c.capacity()).toMatchObject({working: 0, reserved: 1, used: 0, available: 3});
      c.setTaskReservations([], true);
      expect(await c.capacity()).toMatchObject({working: 0, reserved: 0, used: 0});
    } finally { c.close(); f.dispose(); }
  });
  it("serializes automatic starts and gives Queue on capacity priority even with Keep Busy off", async () => {
    const f = fixture();
    const c = f.open();
    try {
      monitor(c)!.pendingMessageId = null;
      c.reportWorkingSnapshot([], "sidebar");
      c.setTaskReservations([], true);
      c.policy({keepT3Busy: true, maxWorking: 1});
      const [first, second] = await Promise.all([
        c.acquireAutomaticAdmission("first"),
        c.acquireAutomaticAdmission("second"),
      ]);
      expect([first, second]).toEqual([true, false]);
      c.releaseAutomaticAdmission("first");
      c.policy({keepT3Busy: false});
      const userId = "55555555-5555-4555-8555-555555555555";
      const nextUserId = "66666666-6666-4666-8666-666666666666";
      const claim = {action: "claim" as const, messageId: userId, sessionId: SESSION,
        conversationId: ORIGINAL};
      expect(await c.capacityMessage(claim)).toMatchObject({status: "admitted"});
      c.policy({keepT3Busy: true});
      expect(await c.acquireAutomaticAdmission("taskboard-reservation")).toBe(false);
      c.policy({keepT3Busy: false});
      expect(await c.capacityMessage({...claim, messageId: nextUserId}))
        .toMatchObject({status: "waiting"});
      expect(await c.capacity()).toMatchObject({reserved: 1, used: 0});
      expect(await c.capacityMessage({action: "release", messageId: userId,
        reason: "pre_submit_aborted"})).toMatchObject({status: "released"});
      expect(await c.capacityMessage({...claim, messageId: nextUserId}))
        .toMatchObject({status: "admitted"});
      expect(await c.capacityMessage({action: "submit", messageId: nextUserId}))
        .toMatchObject({status: "submitted"});
      expect(await c.capacityMessage({action: "release", messageId: nextUserId,
        reason: "pre_submit_aborted"})).toMatchObject({status: "held"});
      c.close();
      const restarted = f.open();
      try {
        restarted.reportWorkingSnapshot([], "sidebar");
        restarted.setTaskReservations([], true);
        expect(await restarted.capacityMessage({action: "status", messageId: nextUserId}))
          .toMatchObject({status: "submitted"});
        expect(await restarted.capacity()).toMatchObject({used: 0, reserved: 1});
      } finally { restarted.close(); }
    } finally { c.close(); f.dispose(); }
  });
  it("does not undercount a still-green sidebar worker based on an older idle registry read", async () => {
    const f = fixture();
    const c = f.open();
    try {
      f.setRoster([
        { id: SESSION, conversationId: ORIGINAL,
          bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
          status: "done_or_idle", activity: "idle", statusObservedAt: new Date().toISOString() },
        { id: REPLACEMENT, conversationId: REPLACEMENT,
          bootstrapIdentity: {state: "registered", publicId: REPLACEMENT, conversationId: REPLACEMENT},
          status: "working", activity: "working", statusObservedAt: new Date().toISOString() },
      ]);
      c.setTaskReservations([], true);
      c.reportWorkingSnapshot([SESSION, REPLACEMENT], "stale-sidebar");
      const actual = await c.capacity();
      expect(actual).toMatchObject({
        working: 2, reserved: 0, used: 2, available: 1, admissible: true,
      });
    } finally { c.close(); f.dispose(); }
  });
  it("never counts even bootstrapped TaskBoard ownership as green usage", async () => {
    const f = fixture();
    const c = f.open();
    try {
      monitor(c)!.pendingMessageId = null;
      const recent = new Date(Date.now() - 4 * 60_000).toISOString();
      f.setRoster([
        { id: SESSION, conversationId: ORIGINAL,
          bootstrapIdentity: {state: "awaiting_marker", publicId: SESSION, conversationId: ORIGINAL},
          status: "new", activity: "idle", statusObservedAt: new Date().toISOString(),
          binding: {boundAt: recent} },
      ]);
      c.setTaskReservations([{requestId: WAKE, sessionId: SESSION,
        holdUntil: Date.now() + 90_000}], true);
      c.reportWorkingSnapshot([], "sidebar");
      expect(await c.capacity()).toMatchObject({working: 0, reserved: 1, used: 0, available: 3});
      f.setRoster([
        { id: SESSION, conversationId: ORIGINAL,
          bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
          status: "done_or_idle", activity: "idle", statusObservedAt: new Date().toISOString(),
          lastRole: "assistant", binding: {boundAt: recent} },
      ]);
      expect(await c.capacity()).toMatchObject({working: 0, reserved: 1, used: 0, available: 3});
      c.setTaskReservations([{requestId: WAKE, sessionId: SESSION,
        holdUntil: Date.now() - 1}], true);
      expect(await c.capacity()).toMatchObject({working: 0, reserved: 0, used: 0, available: 3});
    } finally { c.close(); f.dispose(); }
  });
  it("shows a durable crossed-out marker only after an agent stop, clearing it on reconfiguration", async () => {
    const f = fixture();
    try {
      const stopped = f.open();
      expect(stopped.stop(SESSION).stopped).toBe(true);
      expect((stopped.status() as { agentStops: Array<{ sessionId: string; publicSessionId?: string }> }).agentStops)
        .toMatchObject([{ sessionId: SESSION, publicSessionId: SESSION }]);
      stopped.close();

      const restarted = f.open();
      expect((restarted.status() as { agentStops: unknown[] }).agentStops).toHaveLength(1);
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: { state: "registered", publicId: SESSION, conversationId: ORIGINAL },
      }]);
      await restarted.set({ sessionId: SESSION, conversationId: ORIGINAL, mode: "idle", keepAwake: false });
      expect((restarted.status() as { agentStops: unknown[] }).agentStops).toHaveLength(0);
      restarted.stop(SESSION, "user");
      expect((restarted.status() as { agentStops: unknown[] }).agentStops).toHaveLength(0);
      restarted.close();
    } finally { f.dispose(); }
  });
  it("preserves settings through a mismatched Bootstrap conversation and only rebinds with positive evidence", async () => {
    const f = fixture();
    const c = f.open();
    try {
      f.setRoster([{
        id: SESSION, conversationId: REPLACEMENT,
        bootstrapIdentity: { state: "mismatch", publicId: SESSION, conversationId: ORIGINAL },
      }]);
      await c.reconcileLifecycle();
      await c.reconcileLifecycle();
      expect(monitor(c)?.conversationId).toBe(ORIGINAL);
      expect(monitor(c)?.beginAt).toBe(f.initial.beginAt);
      expect(monitor(c)?.autoRebootMinutes).toBe(60);
      expect(f.retired()).toBe(0);

      f.verifyRead();
      await c.reconcileLifecycle();
      expect(monitor(c)?.conversationId).toBe(REPLACEMENT);
      expect(monitor(c)?.pendingMessageId).toBeNull();
      expect(monitor(c)?.beginAt).toBe(f.initial.beginAt);
      expect(monitor(c)?.autoRebootMinutes).toBe(60);
      expect(f.retired()).toBe(1);
      c.close();

      const restarted = f.open();
      try {
        expect(monitor(restarted)?.conversationId).toBe(REPLACEMENT);
        expect(monitor(restarted)?.beginAt).toBe(f.initial.beginAt);
        expect(monitor(restarted)?.autoRebootMinutes).toBe(60);
        restarted.start();
        const snapshots = NodeFS.readdirSync(NodePath.join(f.directory, "caffy-snapshots"));
        expect(snapshots.length).toBeGreaterThan(0);
      } finally { restarted.close(); }
    } finally { c.close(); f.dispose(); }
  });

  it("keeps Caffy through snooze, but retires a paused monitor", async () => {
    const f = fixture();
    const c = f.open();
    try {
      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL, snoozedUntil: Date.UTC(9999, 0, 1),
        bootstrapIdentity: {state: "registered", publicId: SESSION, conversationId: ORIGINAL},
      }]);
      await c.reconcileLifecycle();
      expect(monitor(c)).not.toBeNull();
      expect(f.retired()).toBe(0);

      monitor(c)!.paused = true;
      await c.reconcileLifecycle();
      expect(monitor(c)).toBeNull();
      expect(f.retired()).toBe(1);
    } finally { c.close(); f.dispose(); }
  });

  it("does not confuse a cold startup catalog with a deleted T3 session", async () => {
    const f = fixture();
    const c = f.open();
    try {
      await c.reconcileLifecycle();
      await c.reconcileLifecycle();
      expect(monitor(c)).not.toBeNull();

      f.setRoster([{
        id: SESSION, conversationId: ORIGINAL,
        bootstrapIdentity: { state: "registered", publicId: SESSION, conversationId: ORIGINAL },
      }]);
      await c.reconcileLifecycle();
      f.setRoster([]);
      await c.reconcileLifecycle();
      await c.reconcileLifecycle();
      expect(monitor(c)).not.toBeNull(); // Renderer inventory loss never proves a durable close.
      c.retire(SESSION, "closed");
      expect(monitor(c)).toBeNull();
    } finally { c.close(); f.dispose(); }
  });
});
