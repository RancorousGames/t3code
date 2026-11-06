// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Disposable filesystem-based scheduler persistence fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CaffyScheduler, type CaffyConfig } from "./CaffyScheduler.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ORIGINAL = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT = "33333333-3333-4333-8333-333333333333";
const WAKE = "44444444-4444-4444-8444-444444444444";

const makeConfig = (): CaffyConfig => ({
  sessionId: SESSION,
  publicSessionId: SESSION,
  conversationId: ORIGINAL,
  mode: "idle",
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
    }; hidden?: boolean; status?: string; activity?: string; statusObservedAt?: string;
    lastRole?: string; binding?: {boundAt?: string};
  }> = [];
  let guardedRead = false;
  let retirementCount = 0;
  let onDelivery: ((record: {
    sessionId: string; conversationId: string; status: "cancelled"; messageId: string;
  }) => void) | null = null;
  const deliveries = {
    subscribeTransitions: (listener: typeof onDelivery) => { onDelivery = listener; return () => {}; },
    setDispatchPermission: () => {},
    setDispatchAdmission: () => {},
    resumeAllowed: () => {},
    retireRecipient: () => {
      retirementCount++;
      onDelivery?.({ sessionId: SESSION, conversationId: ORIGINAL, status: "cancelled", messageId: WAKE });
      return 1;
    },
  } as unknown as ConstructorParameters<typeof CaffyScheduler>[1];
  const request = (async (input: { requestId: string; action: string }) => ({
    version: 1,
    requestId: input.requestId,
    ok: true,
    data: input.action === "read"
      ? { conversationGuardValidated: guardedRead, verifiedConversationId: REPLACEMENT }
      : { sessions: roster, total: roster.length },
  })) as ConstructorParameters<typeof CaffyScheduler>[2];
  const open = () => new CaffyScheduler(directory, deliveries, request, {
    start: () => 1, stop: () => {},
  }, () => { throw new Error("Never call OS shutdown in tests."); });
  return {
    initial, open,
    setRoster: (rows: typeof roster) => { roster = rows; },
    verifyRead: () => { guardedRead = true; },
    retired: () => retirementCount,
    dispose: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
    directory,
  };
}

const monitor = (scheduler: CaffyScheduler) =>
  scheduler.status(SESSION) as CaffyConfig | null;

describe("Caffy settings survive T3 restart and session lifecycle recovery", () => {
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
  it("preserves settings through a conversation change and only rebinds with positive evidence", async () => {
    const f = fixture();
    const c = f.open();
    try {
      f.setRoster([{
        id: SESSION, conversationId: REPLACEMENT,
        bootstrapIdentity: { state: "registered", publicId: SESSION, conversationId: ORIGINAL },
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
      const missing = (c as unknown as {
        missingSessions: Map<string, {firstSeenAt: number; misses: number}>;
      }).missingSessions.get(SESSION);
      expect(missing).toBeDefined();
      if (missing) missing.firstSeenAt -= 31_000;
      await c.reconcileLifecycle();
      expect(monitor(c)).toBeNull();
    } finally { c.close(); f.dispose(); }
  });
});
