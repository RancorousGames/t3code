import { describe, expect, it } from "vite-plus/test";
import { pendingSessionProgress } from "./chatGPTPendingSessionProgress";

describe("pending session progress", () => {
  it("hides recovery, queued warm loads, and in-flight warm indicators immediately when auto maintenance is paused", () => {
    const now = 100_000;
    const recovery = { now, id: "one", recovery: ["one"], recoveryQueuedAt: 80_000 };
    const warm = { now, id: "one", warm: [{ id: "one", ordinal: 0, notBefore: 120_000 }] };
    const inFlight = { now, id: "one", activeWarmStartedAt: 90_000 };
    for (const input of [recovery, warm, inFlight]) {
      expect(pendingSessionProgress(input)).not.toBeNull();
      expect(pendingSessionProgress({ ...input, paused: true })).toBeNull();
      expect(pendingSessionProgress({ ...input, paused: false })).not.toBeNull();
    }
  });

  it("shows only scheduled sessions, with priority-aware recovery progress", () => {
    expect(pendingSessionProgress({ now: 100_000, id: "ignored" })).toBeNull();
    const front = pendingSessionProgress({ now: 108_000, id: "first", recovery: ["first", "second"],
      recoveryQueuedAt: 90_000 });
    const second = pendingSessionProgress({ now: 108_000, id: "second", recovery: ["first", "second"],
      recoveryQueuedAt: 90_000 });
    expect(front).toMatchObject({ kind: "recovery", rank: 1 });
    expect(second).toMatchObject({ kind: "recovery", rank: 2 });
    expect(front!.progress).toBeGreaterThan(second!.progress);
    const warm = pendingSessionProgress({ now: 100_000, id: "later", warm: [
      { id: "first", ordinal: 0, notBefore: 112_000 },
      { id: "later", ordinal: 1, notBefore: 124_000 },
    ] });
    expect(warm).toMatchObject({ kind: "warm", rank: 2 });
  });

  it("never makes a lower-priority backlog session look farther along", () => {
    const queue = Array.from({ length: 35 }, (_, index) => `session-${index}`);
    for (let i = 0; i < queue.length - 1; i++) {
      const higher = pendingSessionProgress({ now: 0, id: queue[i]!, recovery: queue,
        recoveryQueuedAt: 1, recoveryNextRetryAt: 2_000_000 });
      const lower = pendingSessionProgress({ now: 1_800_000, id: queue[i + 1]!, recovery: queue,
        recoveryQueuedAt: 1, recoveryNextRetryAt: 2_000_000 });
      expect(higher!.progress).toBeGreaterThan(lower!.progress);
    }
  });
  it("rolls overdue progress back rather than getting stuck at completion", () => {
    const first = { id: "session", recovery: ["session"], recoveryQueuedAt: 80_000 };
    const nearlyDue = pendingSessionProgress({ ...first, now: 99_000 });
    const missed = pendingSessionProgress({ ...first, now: 100_000 });
    expect(missed!.progress).toBeLessThan(nearlyDue!.progress);
    expect(missed!.estimatedAt).toBeGreaterThan(100_000);
    const nextCycle = pendingSessionProgress({ ...first, now: 119_000 });
    expect(nextCycle!.progress).toBeGreaterThan(missed!.progress);
    const earlyCooldown = pendingSessionProgress({ ...first, now: 110_000,
      recoveryLastAttemptAt: 100_000, recoveryNextRetryAt: 700_000 });
    const laterCooldown = pendingSessionProgress({ ...first, now: 400_000,
      recoveryLastAttemptAt: 100_000, recoveryNextRetryAt: 700_000 });
    expect(laterCooldown!.progress).toBeGreaterThan(earlyCooldown!.progress);    const delayed = pendingSessionProgress({ ...first, now: 119_000, recoveryNextRetryAt: 170_000 });
    expect(delayed!.progress).toBeLessThan(nextCycle!.progress);
    const movedBack = pendingSessionProgress({ now: 108_000, id: "session",
      recovery: ["new-priority", "session"], recoveryQueuedAt: 80_000 });
    const wasFirst = pendingSessionProgress({ now: 108_000, ...first });
    expect(movedBack!.progress).toBeLessThan(wasFirst!.progress);
  });

  it("shows an in-flight guest and backs off if the attach estimate expires", () => {
    const beforeTimeout = pendingSessionProgress({ now: 144_000, id: "active", activeWarmStartedAt: 100_000 });
    const overdue = pendingSessionProgress({ now: 145_000, id: "active", activeWarmStartedAt: 100_000 });
    expect(beforeTimeout!.progress).toBeGreaterThan(overdue!.progress);
    expect(overdue!.estimatedAt).toBe(160_000);
  });
});
