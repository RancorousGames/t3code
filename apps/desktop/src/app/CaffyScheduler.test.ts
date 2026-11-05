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
    }; hidden?: boolean;
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
