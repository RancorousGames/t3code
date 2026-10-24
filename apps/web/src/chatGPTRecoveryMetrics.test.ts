import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  aggregateChatGPTRecoveryMetrics as aggregate,
  MAX_RECOVERY_EPISODES,
  readChatGPTRecoveryMetrics as read,
  recordChatGPTRecoveryMetric as record,
  type RecoveryEpisode,
} from "./chatGPTRecoveryMetrics";
const values = new Map<string, string>();
const sample = (overrides: Partial<RecoveryEpisode> = {}): RecoveryEpisode => ({
  id: "incident-1",
  sessionId: "session-1",
  category: "red",
  cause: "load-failure",
  startedAt: 100,
  updatedAt: 100,
  attemptCount: 0,
  outcome: "active",
  closedAt: null,
  partial: false,
  ...overrides,
});
beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
it("distinguishes absent, corrupt and inaccessible storage without overwriting it", () => {
  expect(aggregate("env").availability).toBe("missing");
  expect(aggregate("env").successRate).toBeNull();
  record("env", sample());
  const key = [...values.keys()][0]!;
  values.set(key, "{broken");
  expect(read("env").availability).toBe("unavailable");
  expect(record("env", sample())).toBe(false);
  expect(values.get(key)).toBe("{broken");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error();
    },
  });
  expect(record("env", sample())).toBe(false);
});
it("preserves episodes across reads/restarts, counts 50+ attempts without duplicate suppression", () => {
  expect(record("env", sample())).toBe(true);
  for (let n = 1; n <= 55; n++) {
    const update = sample({ updatedAt: 100 + n, attemptCount: n });
    expect(record("env", update)).toBe(true);
    expect(record("env", update)).toBe(true);
  }
  expect(read("env").ledger?.episodes[0]?.attemptCount).toBe(55);
  expect(aggregate("env", 1000)).toMatchObject({ active: 1, closedKnown: 0, successRate: null });
  expect(
    record(
      "env",
      sample({ updatedAt: 1000, attemptCount: 55, closedAt: 1000, outcome: "recovered" }),
    ),
  ).toBe(true);
  expect(aggregate("env").recoveredAttempts.mean).toBe(55);
  expect(aggregate("env").recoveredDurationMs.mean).toBe(900);
  expect(record("env", sample({ updatedAt: 1100, attemptCount: 56 }))).toBe(false);
});
it("uses known closed complete outcomes as denominator and separates categories, partial and ongoing", () => {
  record("env", sample({ closedAt: 200, updatedAt: 200, outcome: "recovered", attemptCount: 1 }));
  record(
    "env",
    sample({
      id: "two",
      sessionId: "two",
      category: "orange",
      cause: "interrupted",
      closedAt: 400,
      updatedAt: 400,
      outcome: "recovered",
      attemptCount: 3,
    }),
  );
  record("env", sample({ id: "failed", closedAt: 500, updatedAt: 500, outcome: "failed" }));
  record("env", sample({ id: "unknown", closedAt: 500, updatedAt: 500, outcome: "unknown" }));
  record(
    "env",
    sample({ id: "partial", closedAt: 500, updatedAt: 500, outcome: "recovered", partial: true }),
  );
  record("env", sample({ id: "active" }));
  const result = aggregate("env", 600);
  expect(result).toMatchObject({
    observed: 6,
    partial: 1,
    recovered: 2,
    failed: 1,
    unknown: 1,
    active: 1,
    closedKnown: 3,
    successRate: 2 / 3,
  });
  expect(result.recoveredDurationMs).toEqual({ n: 2, mean: 200, p50: 200, p90: 300 });
  expect(result.recoveredAttempts).toEqual({ n: 2, mean: 2, p50: 2, p90: 3 });
  expect(result.byCategory.orange.successRate).toBe(1);
  expect(aggregate("another").observed).toBe(0);
});
it("bounds persistence and discloses eviction of unfinished history", () => {
  for (let n = 0; n <= MAX_RECOVERY_EPISODES; n++)
    record("env", sample({ id: `episode-${n}`, startedAt: n, updatedAt: n }));
  expect(read("env").ledger?.episodes).toHaveLength(MAX_RECOVERY_EPISODES);
  expect(aggregate("env")).toMatchObject({
    dropped: 1,
    droppedActive: 1,
    observationStartedAt: 0,
    retainedStartedAt: 1,
  });
});
it("rejects invalid timestamps, free text, stale updates and inconsistent identities", () => {
  expect(record("env", sample({ sessionId: "https://private" }))).toBe(false);
  expect(record("env", sample({ attemptCount: NaN }))).toBe(false);
  expect(record("env", sample({ updatedAt: 90 }))).toBe(false);
  expect(record("env", sample({ outcome: "recovered" }))).toBe(false);
  record("env", sample({ attemptCount: 2, updatedAt: 200 }));
  expect(record("env", sample({ attemptCount: 1, updatedAt: 300 }))).toBe(false);
  expect(record("env", sample({ sessionId: "other", attemptCount: 2, updatedAt: 300 }))).toBe(
    false,
  );
});
it("writes only allowlisted fields and returns false on quota errors", () => {
  const input = { ...sample(), privateText: "never persist me" };
  record("env", input);
  expect([...values.values()].join()).not.toContain("privateText");
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error();
    },
  });
  expect(record("env", sample())).toBe(false);
});
it("rejects evicted replay and permits a fresh incident after a closed one", () => {
  for (let n = 0; n <= MAX_RECOVERY_EPISODES; n++)
    record("env", sample({ id: `episode-${n}`, startedAt: n, updatedAt: n }));
  expect(record("env", sample({ id: "episode-0", startedAt: 0, updatedAt: 1000 }))).toBe(false);
  expect(aggregate("env").dropped).toBe(1);
  record("fresh", sample({ outcome: "recovered", closedAt: 200, updatedAt: 200 }));
  record("fresh", sample({ id: "incident-2", startedAt: 300, updatedAt: 300 }));
  expect(aggregate("fresh")).toMatchObject({ observed: 2, recovered: 1, active: 1 });
});
it("refuses unknown versions and malformed rows without a destructive migration", () => {
  record("env", sample());
  const key = [...values.keys()][0]!;
  const raw = values.get(key)!;
  values.set(key, raw.replace('"version":1', '"version":2'));
  expect(read("env").availability).toBe("unavailable");
  expect(record("env", sample())).toBe(false);
  values.set(key, raw.replace('"startedAt":100', '"startedAt":null'));
  expect(read("env").availability).toBe("unavailable");
});
