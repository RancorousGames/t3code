import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  aggregateChatGPTRecoveryMetrics as aggregate,
  MAX_RECOVERY_EPISODES,
  MAX_OBSERVATION_GAPS,
  recordChatGPTRecoveryObservation as observe,
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
  expect(observe("env", 100)).toBe(true);
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
  expect(observe("env", 1000)).toBe(true);
  expect(aggregate("env").recoveredAttempts.mean).toBe(55);
  expect(aggregate("env").recoveredDurationMs.mean).toBe(900);
  expect(record("env", sample({ updatedAt: 1100, attemptCount: 56 }))).toBe(false);
});
it("uses known closed complete outcomes as denominator and separates categories, partial and ongoing", () => {
  observe("env", 100);
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
  observe("env", 600);
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
  observe("fresh", 100);
  record("fresh", sample({ outcome: "recovered", closedAt: 200, updatedAt: 200 }));
  record("fresh", sample({ id: "incident-2", startedAt: 300, updatedAt: 300 }));
  observe("fresh", 300);
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

it("censors missing observation, preserves provenance and never invents rates", () => {
  record("env", sample({ source: "manual", closedAt: 200, updatedAt: 200, outcome: "recovered" }));
  expect(aggregate("env")).toMatchObject({
    observationCoverage: "untracked",
    recovered: 0,
    successRate: null,
    observed: 1,
  });
  observe("env", 300);
  record(
    "env",
    sample({
      id: "route",
      startedAt: 300,
      updatedAt: 400,
      source: "lost-route",
      outcome: "recovered",
      closedAt: 400,
    }),
  );
  observe("env", 400);
  expect(aggregate("env").bySource["lost-route"]?.successRate).toBe(1);
  expect(aggregate("env").bySource.manual?.successRate).toBeNull();
  expect(aggregate("env").eligibleEpisodes).toBe(1);
  expect(record("env", sample({ id: "badsource", source: "https://private" as any }))).toBe(false);
});
it("marks observed outages and censors episodes spanning missing periods", () => {
  observe("env", 100, 50);
  record("env", sample({ source: "automatic" }));
  observe("env", 120, 50);
  expect(observe("env", 200, 50)).toBe(true); // missing (120,200)
  record(
    "env",
    sample({
      source: "automatic",
      updatedAt: 300,
      closedAt: 300,
      outcome: "recovered",
      attemptCount: 1,
    }),
  );
  observe("env", 300, 150);
  const result = aggregate("env", 300);
  expect(result).toMatchObject({
    observationCoverage: "probe-tracked",
    censoredByGap: 1,
    eligibleEpisodes: 0,
    recovered: 0,
    closedKnown: 0,
    successRate: null,
  });
  expect(result.unobservedPeriods).toMatchObject({
    count: 1,
    elapsedMs: 80,
    retained: 1,
    truncated: false,
  });
  expect(observe("env", 300, 50)).toBe(true); // idempotent
  expect(observe("env", 299, 50)).toBe(false); // no clock rollback
  expect(aggregate("env").unobservedPeriods?.count).toBe(1);
});
it("bounds outage history; old intervals remain explicitly censored", () => {
  observe("env", 0, 1);
  for (let i = 1; i <= MAX_OBSERVATION_GAPS + 1; i++) observe("env", i * 10, 1);
  expect(aggregate("env").unobservedPeriods).toMatchObject({
    count: MAX_OBSERVATION_GAPS + 1,
    retained: MAX_OBSERVATION_GAPS,
    truncated: true,
  });
});
it("retains monotonic action ordinals and excludes malformed or rolled-back counters", () => {
  const initial = sample({ actions: { reload: 0, stop: 0, continue: 0 } });
  expect(record("env", initial)).toBe(true);
  const updated = sample({
    updatedAt: 200,
    attemptCount: 2,
    actions: { reload: 1, stop: 1, continue: 0 },
  });
  expect(record("env", updated)).toBe(true);
  expect(record("env", updated)).toBe(true);
  expect(
    record(
      "env",
      sample({ updatedAt: 300, attemptCount: 2, actions: { reload: 1, stop: 0, continue: 1 } }),
    ),
  ).toBe(false);
  expect(
    record(
      "env",
      sample({ updatedAt: 300, attemptCount: 2, actions: { reload: 3, stop: 0, continue: 0 } }),
    ),
  ).toBe(false);
  expect(aggregate("env").actions).toEqual({ reload: 1, stop: 1, continue: 0 });
});
