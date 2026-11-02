import { describe, expect, it, vi } from "vite-plus/test";
import {
  RECOVERY_EXPERIMENT_ARMS, advanceRecoveryExperiment, observedRecoveryWorkload, recoveryOpportunityCategories, verifiedExperimentEpisodes,
  currentRecoveryExperimentArm, recoveryExperimentStatistics, recoveryExperimentSummaryReport, readRecoveryExperiment, saveRecoveryExperiment, suspendRecoveryExperiment, toggledRecoveryExperiment,
  type RecoveryExperimentState,
} from "./chatGPTRecoveryExperiment";
import type { ObservationCoverage, RecoveryEpisode } from "./chatGPTRecoveryMetrics";
const initial = (): RecoveryExperimentState => ({
  version: 1, enabled: true, armId: "steady",
  armStartedAt: 100, lastEvaluatedAt: 100, round: 0, samples: [], seenIds: [],
});
const episode = (id: string, outcome: RecoveryEpisode["outcome"], partial = false): RecoveryEpisode => ({
  id, sessionId: "session1", category: "red", cause: "stalled", source: "automatic",
  startedAt: 200, updatedAt: 600, closedAt: outcome === "active" ? null : 600,
  attemptCount: 2, outcome, partial,
});
describe("recovery experimentation", () => {
  it("does not classify interrupted or unknown ChatGPT work as an idle workload", () => {
    const now = 300_000;
    expect(observedRecoveryWorkload([
      { activity: "idle", observedAt: now },
      { activity: "working", observedAt: now - 1_000 },
    ], now)).toBe(1);
    for (const unreliable of ["interrupted", "invalid", "delivery-timeout", "unknown"]) {
      // With at most two potentially active sessions the 0-3 bucket is
      // certain, even though the precise number of active sessions is not.
      expect(observedRecoveryWorkload([
        { activity: "idle", observedAt: now },
        { activity: unreliable, observedAt: now },
      ], now)).toBe(0);
    }
    expect(observedRecoveryWorkload([{ activity: "working", observedAt: now - 120_001 }], now)).toBe(0);
    expect(observedRecoveryWorkload([{ activity: "idle", observedAt: now + 1 }], now)).toBe(0);
    // Missing session snapshots must count as potentially active: 3 vs 4
    // spans different workload cohorts; 8+ remains unambiguous.
    expect(observedRecoveryWorkload(
      Array.from({ length: 3 }, () => ({ activity: "working", observedAt: now })), now, 4,
    )).toBeNull();
    expect(observedRecoveryWorkload(
      Array.from({ length: 8 }, () => ({ activity: "working", observedAt: now })), now, 12,
    )).toBe(8);
    expect(observedRecoveryWorkload([], now, 5)).toBeNull();
    expect(observedRecoveryWorkload([], now, 0)).toBeNull();
  });
  it("counts only complete automatic episodes and deduplicates across samples", () => {
    const completed = episode("one", "recovered");
    const manual = { ...episode("two", "recovered"), source: "manual" as const };
    const first = advanceRecoveryExperiment(initial(), [
      completed, manual, episode("three", "active"), episode("four", "unknown"),
      episode("five", "failed", true),
    ], 9, 1_000);
    expect(first.samples).toEqual([{
      episodeId: "one", armId: "steady", recovered: true, busyBucket: "8+", category: "red", durationMs: 400, startedAt: 200, observedAt: 1_000,
    }]);
    expect(advanceRecoveryExperiment(first, [completed], 9, 2_000).samples).toHaveLength(1);
  });
  it("rotates only after elapsed time or sufficiently observed closed outcomes", () => {
    const early = advanceRecoveryExperiment(initial(), [episode("one", "failed")], 1, 500);
    expect(early.armId).toBe("steady");
    const enough = Array.from({ length: 5 }, (_, i) => episode("e" + i, "failed"));
    let switched = initial();
    for (let tick = 1; tick <= 41; tick++) {
      switched = advanceRecoveryExperiment(switched, enough, 2, 100 + tick * 30_000);
    }
    expect(switched.armId).toBe("responsive");
    expect(currentRecoveryExperimentArm(switched)).toEqual(RECOVERY_EXPERIMENT_ARMS[1]);
    let bounded = switched;
    for (let tick = 1; tick <= 121; tick++) {
      bounded = advanceRecoveryExperiment(bounded, [], 2, switched.lastEvaluatedAt + tick * 30_000);
    }
    expect(bounded.armId).toBe("moderate");
    expect(recoveryExperimentStatistics(switched)[0]?.observedRecoveryRate).toBe(0);
  });
  it("does not mistake missing activity observations for an idle account", () => {
    const next = advanceRecoveryExperiment(initial(), [episode("unobserved", "recovered")], null, 900);
    expect(next.samples[0]?.busyBucket).toBe("unknown");
    expect(recoveryExperimentStatistics(next)[0]?.buckets.at(-1)?.count).toBe(1);
  });
  it("computes recoveries per observed hour and censors long pauses", () => {
    const state = { ...initial(), lastEvaluatedAt: 1_000, exposureMs: { steady: 4 * 60_000 },
      bucketExposureSince: 1, exposureByBucketMs: { "steady|0-3": 4 * 60_000 } };
    const next = advanceRecoveryExperiment(state, [episode("once", "recovered"), episode("twice", "recovered"), episode("thrice", "recovered")], 2, 32_000);
    const row = recoveryExperimentStatistics(next)[0]!;
    expect(row.observedHours).toBeGreaterThan(0.07);
    expect(row.recoveredPerHour).toBeNull(); // 4m31s, insufficient exposure.
    const late = advanceRecoveryExperiment(next, [], null, 10_000_000);
    expect(late.exposureMs?.steady).toBe(4 * 60_000 + 31_000 + 120_000);
    expect(late.missingExposureMs).toBeGreaterThan(8_000_000);
    expect(recoveryExperimentStatistics(late)[0]?.recoveredPerHour).toBeGreaterThan(0);
  });
  it("does not score no-failure idle windows as recovery throughput", () => {
    const state = initial();
    const next = advanceRecoveryExperiment(state, [], null, 30_100, false);
    expect(next.exposureMs?.steady).toBe(0);
    expect(next.noOpportunityMs).toBe(30_000);
    expect(next.armStartedAt).toBe(30_100);
    expect(next.armId).toBe("steady");
  });
  it("pauses exposure and arm rotation while automatic recovery is disabled", () => {
    const before = { ...initial(), lastEvaluatedAt: 1_000, armStartedAt: 500 };
    const paused = suspendRecoveryExperiment(before, 5_000_000);
    expect(paused.armStartedAt).toBe(4_999_500);
    expect(paused.lastEvaluatedAt).toBe(5_000_000);
    expect(paused.missingExposureMs).toBe(4_999_000);
    expect(paused.exposureMs).toBe(before.exposureMs);
    expect(advanceRecoveryExperiment(paused, [], null, 5_001_000).armId).toBe("steady");
    expect(suspendRecoveryExperiment({ ...before, enabled: false }, 50_000).lastEvaluatedAt).toBe(1_000);
  });
  it("optimizes recovery throughput only within measured matching workload cohorts", () => {
    const arms = RECOVERY_EXPERIMENT_ARMS;
    const samples = arms.flatMap(arm => Array.from({ length: 8 }, (_, i) => ({
      episodeId: `${arm.id}-${i}`, armId: arm.id, busyBucket: "0-3",
      recovered: arm.id === "conservative" ? i < 7 : i < 6,
      durationMs: 20_000, observedAt: 100_000,
    })));
    const exposureByBucketMs = Object.fromEntries(arms.map(arm => [
      `${arm.id}|0-3`, arm.id === "conservative" ? 5 * 60_000 : 20 * 60_000,
    ]));
    const candidate = { ...initial(), samples, exposureByBucketMs, bucketExposureSince: 1, lastEvaluatedAt: 1_260_000 };
    const next = advanceRecoveryExperiment(candidate, [], 2, 1_300_000);
    expect(next.armId).toBe("conservative");
    const stat = recoveryExperimentStatistics(next).find(s => s.arm === "conservative");
    expect(stat?.buckets[0]?.recoveredPerHour).toBeGreaterThan(80);
    expect(stat?.buckets[1]?.recoveredPerHour).toBeNull();
  });
  it("does not exploit success percentages when arm workload exposures are missing", () => {
    const arms = RECOVERY_EXPERIMENT_ARMS;
    const samples = arms.flatMap(arm => Array.from({ length: 8 }, (_, i) => ({
      episodeId: `${arm.id}-${i}`, armId: arm.id, busyBucket: "0-3",
      recovered: arm.id === "conservative" ? true : i < 2,
      durationMs: 10_000, observedAt: 100_000,
    })));
    const next = advanceRecoveryExperiment(
      { ...initial(), samples, lastEvaluatedAt: 1_260_000 }, [], 2, 1_300_000,
    );
    expect(next.armId).toBe("responsive"); // fairness fallback: ordinary exploration
  });
  it("does not divide legacy outcomes by newly measured workload exposure", () => {
    const old = {
      ...initial(), lastEvaluatedAt: 1_260_000,
      samples: Array.from({ length: 30 }, (_, i) => ({
        episodeId: "legacy-" + i, armId: "steady", busyBucket: "0-3",
        recovered: true, durationMs: 10_000, observedAt: 10_000,
      })),
      exposureByBucketMs: { "steady|0-3": 20 * 60_000 },
    };
    const next = advanceRecoveryExperiment(old, [], 2, 1_300_000);
    expect(next.bucketExposureSince).toBe(1_260_000);
    expect(next.exposureByBucketMs?.["steady|0-3"]).toBe(40_000);
    const group = recoveryExperimentStatistics(next)[0]?.buckets[0];
    expect(group?.count).toBe(0);
    expect(group?.recoveredPerHour).toBeNull();
  });
  it("switches away from a very low-yield cadence before the normal window ends", () => {
    const poor = Array.from({ length: 10 }, (_, index) => ({
      episodeId: "low-" + index, armId: "steady", busyBucket: "4-7",
      recovered: index === 0, durationMs: 18_000, observedAt: 250_000,
    }));
    const state = { ...initial(), samples: poor, lastEvaluatedAt: 660_100 };
    const next = advanceRecoveryExperiment(state, [], 5, 690_100);
    expect(next.armId).toBe("responsive");
    expect(next.switchHistory?.at(-1)?.reason).toBe("low-yield");
    const lessPoor = poor.map((item, index) => ({ ...item, recovered: index < 2 }));
    expect(advanceRecoveryExperiment({ ...state, samples: lessPoor }, [], 5, 690_100).armId)
      .toBe("steady");
  });
  it("retains cumulative recovery counts when the recent sample window rolls over", () => {
    const samples = Array.from({ length: 1500 }, (_, index) => ({
      episodeId: "prior-" + index, armId: "steady", busyBucket: "0-3",
      recovered: index < 750, durationMs: 10_000, observedAt: 500,
    }));
    const old = { ...initial(), bucketExposureSince: 1, lastEvaluatedAt: 1_000, samples };
    const next = advanceRecoveryExperiment(old, [episode("new-one", "recovered")], 2, 3_000);
    expect(next.samples).toHaveLength(1500);
    expect(next.bucketTotals?.["steady|0-3"]).toEqual({ episodes: 1501, recovered: 751 });
    expect(recoveryExperimentStatistics(next)[0]).toMatchObject({
      episodes: 1501, recovered: 751,
    });
  });
  it("exports only aggregate diagnostics without episode identifiers", () => {
    const state = { ...initial(), bucketExposureSince: 1,
      samples: [{ episodeId: "private-episode-token", armId: "steady",
        busyBucket: "0-3", recovered: true, durationMs: 10_000, observedAt: 500 }] };
    const report = recoveryExperimentSummaryReport(state);
    expect(report).not.toContain("private-episode-token");
    expect(JSON.parse(report).arms[0].episodes).toBe(1);
  });
  it("credits a late recovery to the arm active when the episode began", () => {
    const startedAt = 1_200_000;
    const active: RecoveryEpisode = {
      ...episode("spanning", "active"), startedAt, updatedAt: 1_210_000,
    };
    const priorSamples = Array.from({ length: 5 }, (_, i) => ({
      episodeId: "already-" + i, armId: "steady", busyBucket: "4-7",
      recovered: true, durationMs: 10_000, observedAt: 2_000,
    }));
    const baseline = { ...initial(), lastEvaluatedAt: 1_180_000,
      samples: priorSamples, bucketExposureSince: 1, laneExposureSince: 1 };
    const running = advanceRecoveryExperiment(baseline, [active], 5, 1_210_000);
    expect(running.armId).toBe("responsive");
    expect(running.episodeAssignments?.spanning).toMatchObject({
      armId: "steady", busyBucket: "4-7", startedAt,
    });
    const closed: RecoveryEpisode = { ...active, outcome: "recovered",
      closedAt: 1_240_000, updatedAt: 1_240_000 };
    const finished = advanceRecoveryExperiment(running, [closed], 9, 1_240_000);
    expect(finished.samples.at(-1)).toMatchObject({
      episodeId: "spanning", armId: "steady", busyBucket: "4-7", recovered: true,
    });
    expect(finished.bucketTotals?.["steady|4-7"]).toMatchObject({
      episodes: 6, recovered: 6,
    });
    expect(finished.bucketTotals?.["responsive|8+"]).toBeUndefined();
    expect(finished.laneTotals?.["steady|red|4-7"]).toBeUndefined();
    expect(finished.episodeAssignments?.spanning).toBeUndefined();
    expect(finished.switchHistory?.at(-1)).toMatchObject({
      closedEpisodes: 6, recoveredEpisodes: 6,
    });
  });
  it("attributes newly discovered completed episodes using trial history, or censors unknown ones", () => {
    const baseline = {
      ...initial(), armId: "responsive", armStartedAt: 1_210_000,
      lastEvaluatedAt: 1_240_000, bucketExposureSince: 1,
      switchHistory: [{
        from: "steady", to: "responsive", startedAt: 100,
        finishedAt: 1_210_000, reason: "enough-samples" as const,
        closedEpisodes: 5, recoveredEpisodes: 4,
      }],
    };
    const closed: RecoveryEpisode = {
      ...episode("late", "recovered"), startedAt: 1_200_000,
      closedAt: 1_250_000, updatedAt: 1_250_000,
    };
    const old = { ...closed, id: "outside-history", startedAt: 50 };
    const next = advanceRecoveryExperiment(baseline, [closed, old], 5, 1_260_000);
    expect(next.samples.at(-1)).toMatchObject({
      episodeId: "late", armId: "steady", busyBucket: "unknown",
    });
    expect(next.samples.find(s => s.episodeId === "outside-history")).toBeUndefined();
    expect(next.bucketTotals?.["steady|unknown"]?.recovered).toBe(1);
    expect(next.switchHistory?.[0]).toMatchObject({ closedEpisodes: 6, recoveredEpisodes: 5 });
  });
  it("does not mix outcomes from an earlier enabled period into a restarted experiment", () => {
    const previous = { ...initial(), enabled: false, enabledAt: 100,
      episodeAssignments: {
        old: { armId: "steady", busyBucket: "0-3", startedAt: 200 },
      },
    };
    const started = toggledRecoveryExperiment(previous, true, 2_000_000);
    expect(started.enabledAt).toBe(2_000_000);
    expect(started.episodeAssignments).toEqual({});
    const stale: RecoveryEpisode = {
      ...episode("old", "recovered"), startedAt: 200,
      closedAt: 2_000_100, updatedAt: 2_000_100,
    };
    const fresh: RecoveryEpisode = {
      ...episode("fresh", "recovered"), startedAt: 2_000_050,
      closedAt: 2_000_100, updatedAt: 2_000_100,
    };
    const next = advanceRecoveryExperiment(started, [stale, fresh], 1, 2_000_200);
    expect(next.samples.map(s => s.episodeId)).toEqual(["fresh"]);
  });
  it("excludes partial and stale recoveries from observed opportunity time", () => {
    const active = { ...episode("active-one", "active"), startedAt: 200 };
    const closed = { ...episode("closed-one", "recovered"), closedAt: 900, updatedAt: 900 };
    const stale = { ...episode("stale", "recovered"), closedAt: 500, updatedAt: 500 };
    const partial = { ...episode("partial", "active"), partial: true, category: "orange" as const };
    const manual = { ...episode("manual", "active"), source: "manual" as const };
    expect(recoveryOpportunityCategories([active, closed, stale, partial, manual], 600, 1000))
      .toEqual(["red"]);
    expect(recoveryOpportunityCategories([stale, partial, manual], 600, 1000)).toEqual([]);
  });
  it("rejects stale, missing, partial and gapped observation coverage", () => {
    const coverage: ObservationCoverage = {
      firstProbeAt: 100, lastProbeAt: 1000,
      gapCount: 0, missedMs: 0, retiredThrough: null, gaps: [],
    };
    const healthy = { ...episode("healthy", "recovered"), updatedAt: 600, closedAt: 600 };
    expect(verifiedExperimentEpisodes([healthy], coverage, 1100)).toHaveLength(1);
    expect(verifiedExperimentEpisodes([healthy], undefined, 1100)).toHaveLength(0);
    expect(verifiedExperimentEpisodes([healthy], coverage, 700_000)).toHaveLength(0);
    const gap: ObservationCoverage = { ...coverage,
      gapCount: 1, missedMs: 200, gaps: [{ from: 300, to: 500 }] };
    expect(verifiedExperimentEpisodes([healthy], gap, 1100)).toHaveLength(0);
    expect(verifiedExperimentEpisodes([{ ...healthy, partial: true }], coverage, 1100)).toHaveLength(0);
  });
  it("does not attribute spontaneous recovery without dispatched retry actions to a cadence", () => {
    const spontaneous = { ...episode("spontaneous", "recovered"), attemptCount: 0 };
    const assisted = { ...episode("assisted", "recovered"), attemptCount: 1 };
    const state = advanceRecoveryExperiment(initial(), [spontaneous, assisted], 1, 1000);
    expect(state.samples.map(s => s.episodeId)).toEqual(["assisted"]);
    expect(state.seenIds).toContain("spontaneous");
    expect(recoveryOpportunityCategories([spontaneous], 200, 1000)).toEqual([]);
    expect(recoveryOpportunityCategories([assisted], 200, 1000)).toEqual(["red"]);
  });
  it("revisits every recovery cadence on exploration rounds after exploiting a winner", () => {
    const arms = RECOVERY_EXPERIMENT_ARMS;
    const samples = arms.flatMap(arm => Array.from({ length: 8 }, (_, i) => ({
      episodeId: arm.id + "-" + i, armId: arm.id, busyBucket: "0-3",
      recovered: arm.id === "steady", durationMs: 10_000, observedAt: 10_000,
    })));
    const exposureByBucketMs = Object.fromEntries(
      arms.map(arm => [arm.id + "|0-3", 10 * 60_000]));
    for (const [round, expected] of [
      [3, "steady"], [7, "responsive"], [11, "moderate"], [15, "conservative"],
    ] as const) {
      const state = { ...initial(), round, samples,
        bucketExposureSince: 1, exposureByBucketMs, lastEvaluatedAt: 1_260_000 };
      const next = advanceRecoveryExperiment(state, [], 2, 1_300_000);
      expect(next.armId).toBe(expected);
    }
  });
  it("compares recovery arms using matched error lane and account workload", () => {
    const arms = RECOVERY_EXPERIMENT_ARMS;
    const samples = arms.flatMap(arm => Array.from({ length: 8 }, (_, i) => ({
      episodeId: arm.id + "-legacy-" + i, armId: arm.id,
      busyBucket: "0-3", recovered: arm.id === "steady", durationMs: 1000, observedAt: 100,
    })));
    const laneTotals = Object.fromEntries(arms.map(arm => [
      arm.id + "|red|0-3", { episodes: 8, recovered: arm.id === "conservative" ? 7 : 1 },
    ]));
    const laneExposureMs = Object.fromEntries(arms.map(arm => [
      arm.id + "|red|0-3", 10 * 60_000,
    ]));
    const state = { ...initial(), samples, laneTotals, laneExposureMs,
      laneExposureSince: 1, lastEvaluatedAt: 1_260_000 };
    const next = advanceRecoveryExperiment(state, [], 1, 1_300_000);
    expect(next.armId).toBe("conservative");
  });
  it("tracks red and orange recovery exposure independently within workload cohorts", () => {
    const started = { ...initial(), lastEvaluatedAt: 1000 };
    const first = advanceRecoveryExperiment(started, [], 5, 31_000, true, ["red"]);
    expect(first.laneExposureMs?.["steady|red|4-7"]).toBe(30_000);
    expect(first.laneExposureMs?.["steady|orange|4-7"]).toBeUndefined();
    const both = advanceRecoveryExperiment(first, [], 5, 61_000, true, ["red", "orange"]);
    expect(both.laneExposureMs?.["steady|red|4-7"]).toBe(60_000);
    expect(both.laneExposureMs?.["steady|orange|4-7"]).toBe(30_000);
    const stopped = advanceRecoveryExperiment(both, [], 5, 91_000, false, []);
    expect(stopped.laneExposureMs?.["steady|red|4-7"]).toBe(60_000);
    const report = recoveryExperimentStatistics(stopped)[0];
    expect(report?.laneBuckets.find(s => s.category === "red" && s.busyBucket === "4-7")?.observedHours)
      .toBeCloseTo(60_000 / 3_600_000);
  });
  it("records lane-conditioned success from an actual completed automatic episode", () => {
    const running: RecoveryEpisode = { ...episode("by-lane", "active"),
      category: "orange", startedAt: 2000, updatedAt: 2000 };
    const base = { ...initial(), lastEvaluatedAt: 1000 };
    const first = advanceRecoveryExperiment(base, [running], 2, 31_000, true, ["orange"]);
    const closed: RecoveryEpisode = { ...running, outcome: "recovered",
      closedAt: 40_000, updatedAt: 40_000, attemptCount: 1 };
    const second = advanceRecoveryExperiment(first, [closed], 2, 41_000, true, ["orange"]);
    expect(second.laneTotals?.["steady|orange|0-3"]).toEqual({ episodes: 1, recovered: 1 });
    expect(second.laneTotals?.["steady|red|0-3"]).toBeUndefined();
  });
  it("does not trigger an early arm switch from outcomes that began in old trials", () => {
    const old = Array.from({ length: 10 }, (_, i) => ({
      episodeId: "old-" + i, armId: "steady", busyBucket: "0-3",
      startedAt: 200, observedAt: 1_610_000, recovered: false, durationMs: 1000,
    }));
    const baseline = { ...initial(), armStartedAt: 1_000_000,
      lastEvaluatedAt: 1_600_000, samples: old };
    expect(advanceRecoveryExperiment(baseline, [], 1, 1_630_000).armId).toBe("steady");
    const current = old.map(sample => ({ ...sample, startedAt: 1_100_000 }));
    expect(advanceRecoveryExperiment({ ...baseline, samples: current }, [], 1, 1_630_000).armId)
      .toBe("responsive");
  });
  it("censors pending incident attribution after a manual recovery pause", () => {
    const active: RecoveryEpisode = { ...episode("paused-incident", "active"),
      startedAt: 2_000, updatedAt: 3_000 };
    const initialState = { ...initial(), lastEvaluatedAt: 3_000 };
    const running = advanceRecoveryExperiment(initialState, [active], 2, 4_000);
    expect(running.episodeAssignments?.["paused-incident"]).toBeDefined();
    const paused = suspendRecoveryExperiment(running, 100_000);
    expect(paused.episodeAssignments).toEqual({});
    const closed: RecoveryEpisode = { ...active, outcome: "recovered",
      closedAt: 101_000, updatedAt: 101_000, attemptCount: 1 };
    const resumed = advanceRecoveryExperiment(paused, [closed], 2, 101_500);
    expect(resumed.samples.some(s => s.episodeId === "paused-incident")).toBe(false);
  });
  it("prunes pending assignments when their recovery episodes disappear from the bounded ledger", () => {
    const assignment = { armId: "steady", busyBucket: "0-3", startedAt: 200 };
    const old = { ...initial(), episodeAssignments: { orphan: assignment, retained: assignment } };
    const retained = { ...episode("retained", "active"), startedAt: 200 };
    const next = advanceRecoveryExperiment(old, [retained], 1, 1000);
    expect(next.episodeAssignments?.orphan).toBeUndefined();
    expect(next.episodeAssignments?.retained).toEqual(assignment);
  });
  it("keeps experiment persistence failures from crashing session monitoring", () => {
    const previous = JSON.stringify(initial());
    const unavailable = {
      getItem: () => previous,
      setItem: () => { throw new Error("QuotaExceededError"); },
    } as unknown as Storage;
    expect(saveRecoveryExperiment(initial(), unavailable)).toBe(false);
    expect(unavailable.getItem("any")).toBe(previous);
  });
  it("retires closed unknown outcomes without attributing a recovery", () => {
    const active: RecoveryEpisode = { ...episode("ambiguous", "active"), startedAt: 200 };
    const running = advanceRecoveryExperiment(initial(), [active], 1, 400);
    expect(running.episodeAssignments?.ambiguous).toBeDefined();
    const unknown: RecoveryEpisode = { ...active, outcome: "unknown",
      closedAt: 600, updatedAt: 600 };
    const finished = advanceRecoveryExperiment(running, [unknown], 1, 1000);
    expect(finished.episodeAssignments?.ambiguous).toBeUndefined();
    expect(finished.seenIds).toContain("ambiguous");
    expect(finished.samples).toEqual([]);
  });
  it("handles localStorage security getters that throw before a read or save begins", () => {
    vi.stubGlobal("window", {
      get localStorage() { throw new Error("SecurityError"); },
    });
    try {
      expect(readRecoveryExperiment().enabled).toBe(false);
      expect(saveRecoveryExperiment(initial())).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("does not choose orange scheme variants from red-only recovery evidence", () => {
    const arms = RECOVERY_EXPERIMENT_ARMS;
    const samples = arms.flatMap(arm => Array.from({ length: 8 }, (_, i) => ({
      episodeId: arm.id + "-legacy-" + i, armId: arm.id, busyBucket: "0-3",
      recovered: false, durationMs: 15_000, observedAt: 100_000,
    })));
    const laneTotals = Object.fromEntries(arms.map(arm => [
      arm.id + "|red|0-3", {
        episodes: 8, recovered: arm.id === "steady-reload-only" ? 8 :
          arm.id === "moderate" ? 7 : 1,
      },
    ]));
    const laneExposureMs = Object.fromEntries(
      arms.map(arm => [arm.id + "|red|0-3", 10 * 60_000]));
    const state = { ...initial(), samples, laneExposureSince: 1,
      laneTotals, laneExposureMs, lastEvaluatedAt: 1_260_000 };
    const winner = advanceRecoveryExperiment(state, [], 1, 1_300_000);
    expect(winner.armId).toBe("moderate");
  });
  it("can choose an orange scheme once all candidates have matched orange evidence", () => {
    const arms = RECOVERY_EXPERIMENT_ARMS;
    const laneTotals = Object.fromEntries(arms.flatMap(arm => [
      [arm.id + "|red|0-3", {
        episodes: 8, recovered: arm.id === "moderate" ? 7 : 1,
      }],
      [arm.id + "|orange|0-3", {
        episodes: 8, recovered: arm.id === "steady-reload-only" ? 8 : 1,
      }],
    ]));
    const laneExposureMs = Object.fromEntries(arms.flatMap(arm => [
      [arm.id + "|red|0-3", 10 * 60_000],
      [arm.id + "|orange|0-3", 10 * 60_000],
    ]));
    const orangeSchemeSamples = arms.flatMap(arm => Array.from({ length: 8 }, (_, i) => ({
      episodeId: arm.id + "-observed-" + i, armId: arm.id, busyBucket: "0-3",
      recovered: i < 4, durationMs: 10_000, observedAt: 100_000,
    })));
    const state = { ...initial(), samples: orangeSchemeSamples, laneTotals, laneExposureMs,
      laneExposureSince: 1, lastEvaluatedAt: 1_260_000 };
    const next = advanceRecoveryExperiment(state, [], 1, 1_300_000);
    expect(next.armId).toBe("steady-reload-only");
  });
  it("never changes disabled experiments", () => {
    const state = { ...initial(), enabled: false };
    expect(advanceRecoveryExperiment(state, [episode("one", "recovered")], 2, 5_000)).toBe(state);
  });
});
