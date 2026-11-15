// @effect-diagnostics globalDate:off -- Fixed dates model persisted TaskBoard timestamps.
import { describe, expect, it } from "vite-plus/test";
import { ActiveWorkFifo, type ActiveWork } from "./ActiveWorkFifo.ts";
import { decideQueueRecovery, type RecoveryQueueItem, type RecoverySession } from "./QueueRecoveryPolicy.ts";

const NOW = Date.parse("2026-11-15T06:00:00Z");
const task = (id: string, state: string, sinceMinutes: number, changes: Partial<ActiveWork> = {}): ActiveWork => ({
  boardRoot: "D:/board", taskId: id, queueRequest: "00000000-0000-4000-8000-000000000001",
  reservationId: id + "-start", state, stateSince: new Date(NOW - sinceMinutes * 60_000).toISOString(),
  ...changes,
});

describe("Active Work FIFO", () => {
  it("rotates healthy work to the tail, so a stalled task is checked without a deadline scheduler", () => {
    const fifo = new ActiveWorkFifo();
    fifo.sync([task("C", "working", 10), task("A", "starting", 30),
      task("B", "working", 20)], NOW);
    expect(fifo.take(1).map(row => row.taskId)).toEqual(["A"]);
    expect(fifo.take(1).map(row => row.taskId)).toEqual(["B"]);
    expect(fifo.take(1).map(row => row.taskId)).toEqual(["C"]);
    expect(fifo.take(1).map(row => row.taskId)).toEqual(["A"]);
  });

  it("rebuilds from TaskBoard and never duplicates existing attempts across polls", () => {
    const fifo = new ActiveWorkFifo();
    const rows = [task("A", "reserved", 30), task("B", "working", 20)];
    fifo.sync(rows, NOW);
    fifo.take(1);
    fifo.sync(rows.map(row => ({...row, state: "working"})), NOW + 1000);
    expect(fifo.size).toBe(2);
    expect(fifo.take(2).map(row => row.taskId)).toEqual(["B", "A"]);
  });

  it("removes completed or cancelled work and appends new execution attempts", () => {
    const fifo = new ActiveWorkFifo();
    fifo.sync([task("A", "starting", 30), task("B", "working", 20)], NOW);
    fifo.sync([task("A", "completed", 30), task("B", "working", 20),
      task("C", "reserved", 1), task("D", "recovery_required", 30)], NOW);
    expect(fifo.take(4).map(row => row.taskId)).toEqual(["B", "C"]);
    fifo.sync([task("B", "working", 20, {reservationId: "B-second-attempt"})], NOW);
    expect(fifo.take(2).map(row => row.reservationId)).toEqual(["B-second-attempt"]);
  });

  it("tracks corrupted queued requests and never includes normal queued or legacy OpenRig work", () => {
    const fifo = new ActiveWorkFifo();
    fifo.sync([task("Q", "queued", 4), task("X", "queued", 4, {queueRequest: "invalid"}),
      task("L", "starting", 4, {legacyOpenRig: true})], NOW);
    expect(fifo.take(10).map(row => row.taskId)).toEqual(["X"]);
  });

  it("rotates healthy workers while repairing expired, absent and uncertain starts", () => {
    const fifo = new ActiveWorkFifo();
    const reservationId = "00000000-0000-4000-8000-000000000002";
    const rows = [
      task("healthy", "working", 70, {reservationId}),
      task("expired", "reserved", 60, {reservationId}),
      task("absent", "starting", 50, {reservationId}),
      task("uncertain", "starting", 50, {reservationId}),
      task("finished", "completed", 60, {reservationId}),
    ];
    fifo.sync(rows, NOW);
    const live: RecoverySession = {
      id: "session-healthy", spawnRequestId: reservationId,
      conversationId: "conversation-healthy",
      bootstrapIdentity: {state: "registered", conversationId: "conversation-healthy"},
    };
    const unknown: RecoverySession = {
      id: "session-unknown", spawnRequestId: reservationId, totalTurns: 0,
      bootstrapIdentity: {state: "awaiting_marker"},
    };
    const decisions = fifo.take(10).map(entry => {
      const row = rows.find(candidate => candidate.taskId === entry.taskId)!;
      const item = {...row, claimed: row.taskId === "healthy", readiness: true,
        legacyOpenRig: false, sessionId: row.taskId === "healthy" ? live.id : undefined,
        reservationExpiresAt: row.taskId === "expired"
          ? new Date(NOW - 600_000).toISOString() : undefined} as RecoveryQueueItem;
      const sessions = row.taskId === "healthy" ? [live]
        : row.taskId === "uncertain" ? [unknown] : [];
      return [entry.taskId, decideQueueRecovery(item, sessions, NOW, entry.firstObservedAt)?.action ?? "healthy"];
    });
    expect(decisions).toEqual([
      ["healthy", "healthy"], ["expired", "expire"],
      ["absent", "abandon"], ["uncertain", "incident"],
    ]);
  });

  it("handles empty batches and missing legacy timestamps without making new durable journals", () => {
    const fifo = new ActiveWorkFifo();
    fifo.sync([task("A", "starting", 1, {stateSince: null})], NOW);
    expect(fifo.take(0)).toEqual([]);
    expect(fifo.take(1)[0]?.firstObservedAt).toBe(NOW);
    fifo.sync([], NOW + 1000);
    expect(fifo.size).toBe(0);
    expect(fifo.take(1)).toEqual([]);
  });
});
