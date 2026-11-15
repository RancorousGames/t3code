import { describe, expect, it } from "vite-plus/test";
import { decideQueueRecovery, type RecoveryQueueItem, type RecoverySession } from "./QueueRecoveryPolicy.ts";

const NOW = Date.parse("2026-11-15T02:00:00Z");
const hour = 60 * 60_000;
const item = (state: RecoveryQueueItem["state"], changes: Partial<RecoveryQueueItem> = {}): RecoveryQueueItem => ({
  taskId: "MISC-0153", state, queueRequest: "00000000-0000-4000-8000-000000000001",
  reservationId: "00000000-0000-4000-8000-000000000002", claimed: false, readiness: true,
  legacyOpenRig: false, stateSince: new Date(NOW - 2 * hour).toISOString(),
  ...changes,
});
const guest = (changes: Partial<RecoverySession> = {}): RecoverySession => ({
  id: "guest-1", spawnRequestId: "00000000-0000-4000-8000-000000000002",
  bootstrapIdentity: {state: "awaiting_marker"},
  totalTurns: 0, lastRole: null, status: "loading",
  ...changes,
});
const decision = (task: RecoveryQueueItem, guests: RecoverySession[] = []) =>
  decideQueueRecovery(task, guests, NOW, NOW - 2 * hour);

describe("Queue recovery liveness and safety", () => {
  it("expires pre-spawn leases, but never an unexpired lease or terminal phase", () => {
    expect(decision(item("reserved", {reservationExpiresAt: new Date(NOW - hour).toISOString()}))?.action)
      .toBe("expire");
    expect(decision(item("reserved", {reservationExpiresAt: new Date(NOW + hour).toISOString()})))
      .toBeNull();
    expect(decision(item("reserved"))?.action).toBe("incident");
    expect(decision(item("queued"))).toBeNull();
    expect(decision(item("completed"))).toBeNull();
    expect(decision(item("recovery_required"))).toBeNull();
  });

  it("requeues an absent start, resumes a confirmed worker, escalates an UNKNOWN guest", () => {
    expect(decision(item("starting"))?.action).toBe("abandon");
    expect(decision(item("starting"), [guest()])?.action).toBe("incident");
    const registered = guest({
      conversationId: "conversation-1", lastRole: "assistant", totalTurns: 1,
      bootstrapIdentity: {state: "registered", conversationId: "conversation-1"},
    });
    expect(decision(item("starting"), [registered])).toMatchObject({action: "working", sessionId: "guest-1"});
    expect(decision(item("starting"), [guest({closedAt: "closed"})])?.action).toBe("abandon");
    expect(decision(item("starting"), [guest(), guest({id: "guest-2"})])?.action).toBe("incident");
  });

  it("never replaces a claimed worker from incomplete identity evidence", () => {
    expect(decision(item("working", {claimed: true, sessionId: "guest-1"}))?.action)
      .toBe("incident");
    expect(decision(item("working", {claimed: false, sessionId: "guest-1"}))?.action)
      .toBe("requeue-released");
    const valid = guest({
      conversationId: "conversation-1",
      bootstrapIdentity: {state: "registered", conversationId: "conversation-1"},
    });
    expect(decision(item("working", {claimed: true, sessionId: "guest-1"}), [valid])).toBeNull();
    const staleWorker = item("working", {claimed: true, sessionId: "guest-1",
      stateSince: new Date(NOW - 13 * hour).toISOString()});
    expect(decision(staleWorker, [valid])?.action).toBe("incident");
    expect(decision(staleWorker, [guest({...valid, lastWorkingAt: NOW - hour})]))
      .toBeNull();
  });

  it("flags malformed queued and in-flight identities instead of silently filtering them", () => {
    expect(decision(item("queued", {queueRequest: "broken-id"}))?.action).toBe("incident");
    expect(decision(item("starting", {reservationId: null}))?.action).toBe("incident");
    expect(decision(item("working", {queueRequest: ""}))?.action).toBe("incident");
  });

  it("persists age across restarts and bounds every unknown Starting phase", () => {
    const unknown = item("starting", {stateSince: null});
    expect(decideQueueRecovery(unknown, [guest()], NOW, NOW - 40 * 60_000)).toBeNull();
    expect(decideQueueRecovery(unknown, [guest()], NOW, NOW - 46 * 60_000)?.action)
      .toBe("incident");
  });
});
