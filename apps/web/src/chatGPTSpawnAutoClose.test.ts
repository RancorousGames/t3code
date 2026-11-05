import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  SPAWN_AUTO_CLOSE_IDLE_MS,
  observeSpawnAutoCloseActivity,
  readSpawnAutoCloseIdleSince,
  spawnAutoCloseCandidate,
} from "./chatGPTSpawnAutoClose";

const now = Date.parse("2026-11-05T06:00:00Z");
const worker = {
  id: "worker-1",
  title: "T3-0248 task worker",
  creationOrigin: "backend" as const,
  spawnRequestId: "taskboard-request-1",
  autoClose: true,
} satisfies BrowserSession;

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

describe("explicit spawn auto-close", () => {
  it("waits one hour of observed idle and restarts the clock after resumed work", () => {
    const store = storage();
    expect(SPAWN_AUTO_CLOSE_IDLE_MS).toBe(3_600_000);
    observeSpawnAutoCloseActivity("pc", worker, "idle", now, store);
    observeSpawnAutoCloseActivity("pc", worker, "idle", now + 2_000, store);
    expect(readSpawnAutoCloseIdleSince("pc", worker.id, store)).toBe(now);
    const eligible = (at: number) => spawnAutoCloseCandidate(
      [worker], worker, undefined, at, readSpawnAutoCloseIdleSince("pc", worker.id, store),
    );
    expect(eligible(now + SPAWN_AUTO_CLOSE_IDLE_MS - 1)).toBeNull();
    expect(eligible(now + SPAWN_AUTO_CLOSE_IDLE_MS)).toMatchObject({
      reason: "auto-close-idle",
      dueAt: now + SPAWN_AUTO_CLOSE_IDLE_MS,
    });
    observeSpawnAutoCloseActivity("pc", worker, "working", now + SPAWN_AUTO_CLOSE_IDLE_MS, store);
    expect(eligible(now + 2 * SPAWN_AUTO_CLOSE_IDLE_MS)).toBeNull();
    observeSpawnAutoCloseActivity("pc", worker, "idle", now + SPAWN_AUTO_CLOSE_IDLE_MS + 10_000, store);
    expect(eligible(now + 2 * SPAWN_AUTO_CLOSE_IDLE_MS)).toBeNull();
    expect(eligible(now + 2 * SPAWN_AUTO_CLOSE_IDLE_MS + 10_000)?.reason).toBe("auto-close-idle");
  });

  it("never arms from errors, uncertainty or non-opted-in spawns", () => {
    const store = storage();
    observeSpawnAutoCloseActivity("pc", worker, "working", now, store);
    expect(readSpawnAutoCloseIdleSince("pc", worker.id, store)).toBeNull();
    observeSpawnAutoCloseActivity("pc", worker, "idle", now, store);
    observeSpawnAutoCloseActivity("pc", worker, "unknown", now + 1, store);
    expect(readSpawnAutoCloseIdleSince("pc", worker.id, store)).toBe(now);
    observeSpawnAutoCloseActivity("pc", worker, "interrupted", now + 2, store);
    expect(readSpawnAutoCloseIdleSince("pc", worker.id, store)).toBeNull();
    observeSpawnAutoCloseActivity("pc", { ...worker, autoClose: false }, "idle", now, store);
    expect(readSpawnAutoCloseIdleSince("pc", worker.id, store)).toBeNull();
  });

  it("protects selected, human-owned, highlighted, snoozed and parenting sessions", () => {
    const since = now - SPAWN_AUTO_CLOSE_IDLE_MS;
    const due = (session: BrowserSession, sessions: BrowserSession[] = [session], selected?: string) =>
      spawnAutoCloseCandidate(sessions, session, selected, now, since);
    expect(due(worker)?.reason).toBe("auto-close-idle");
    expect(due(worker, [worker], worker.id)).toBeNull();
    expect(due({ ...worker, humanControlled: true })).toBeNull();
    expect(due({ ...worker, autoCloseExempt: true })).toBeNull();
    expect(due({ ...worker, borderColor: "blue" })).toBeNull();
    expect(due({ ...worker, snoozedUntil: now + 100 })).toBeNull();
    expect(due({ ...worker, verificationPending: true })).toBeNull();
    expect(due({ ...worker, binding: {
      seatId: null, role: "manager", parentSessionId: null,
      taskRef: null, boundAt: "2026-11-05T00:00:00Z", boundBy: "omcp_spawn",
    } })).toBeNull();
    expect(due(worker, [worker, { id: "child", title: "Child", parentSessionId: worker.id }])).toBeNull();
    expect(due({ ...worker, spawnRequestId: undefined })).toBeNull();
    expect(due({ ...worker, autoClose: undefined })).toBeNull();
    expect(due(worker, [worker], undefined)?.dueAt).toBe(now);
  });
});
