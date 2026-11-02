import type { ChatGPTOrangeRecoveryStrategy } from "./chatGPTOrangeRecoveryStrategy";
import {
  isFullyObservedRecoveryEpisode,
  MAX_OBSERVATION_INTERVAL_MS,
  type ObservationCoverage,
  type RecoveryCategory,
  type RecoveryEpisode,
} from "./chatGPTRecoveryMetrics";

/** No old or gapped probe can prove recovery results; exclude before sampling. */
export function verifiedExperimentEpisodes(
  episodes: readonly RecoveryEpisode[],
  coverage: ObservationCoverage | undefined,
  now: number,
): RecoveryEpisode[] {
  if (
    !coverage ||
    now < coverage.lastProbeAt ||
    now - coverage.lastProbeAt > MAX_OBSERVATION_INTERVAL_MS
  )
    return [];
  return episodes.filter((episode) => isFullyObservedRecoveryEpisode(episode, coverage));
}

/** Only episodes that can yield a verified outcome represent measurable exposure. */
export function recoveryOpportunityCategories(
  episodes: readonly RecoveryEpisode[],
  lastObservedAt: number,
  now: number,
): RecoveryCategory[] {
  const categories = new Set<RecoveryCategory>();
  for (const episode of episodes) {
    if (episode.source !== "automatic" || episode.partial || episode.startedAt > now) continue;
    if (
      episode.outcome === "active" ||
      (episode.attemptCount > 0 &&
        ["recovered", "failed"].includes(episode.outcome) &&
        episode.closedAt !== null &&
        episode.closedAt > lastObservedAt &&
        episode.closedAt <= now)
    )
      categories.add(episode.category);
  }
  return [...categories];
}

export interface RecoveryExperimentArm {
  id: string;
  redSeconds: number;
  orangeSeconds: number;
  perSessionSeconds: number;
  orangeStrategy: ChatGPTOrangeRecoveryStrategy;
}
// Baseline-first trials: only slow, reload-only recovery until verified success
// is reliably at least 30%. Retain arm IDs for persisted experiment history.
export const RECOVERY_EXPERIMENT_ARMS: readonly RecoveryExperimentArm[] = [
  {
    id: "steady",
    redSeconds: 600,
    orangeSeconds: 1200,
    perSessionSeconds: 1800,
    orangeStrategy: "reload-only",
  },
  {
    id: "responsive",
    redSeconds: 300,
    orangeSeconds: 600,
    perSessionSeconds: 900,
    orangeStrategy: "reload-only",
  },
  {
    id: "moderate",
    redSeconds: 420,
    orangeSeconds: 900,
    perSessionSeconds: 1200,
    orangeStrategy: "reload-only",
  },
  {
    id: "conservative",
    redSeconds: 900,
    orangeSeconds: 1800,
    perSessionSeconds: 2400,
    orangeStrategy: "reload-only",
  },
  {
    id: "steady-reload-only",
    redSeconds: 720,
    orangeSeconds: 1500,
    perSessionSeconds: 2100,
    orangeStrategy: "reload-only",
  },
  {
    id: "steady-reload-stop",
    redSeconds: 1200,
    orangeSeconds: 2400,
    perSessionSeconds: 3600,
    orangeStrategy: "reload-only",
  },
];
export interface RecoveryExperimentSample {
  episodeId: string;
  armId: string;
  busyBucket: string;
  category?: "red" | "orange";
  recovered: boolean;
  attemptCount?: number;
  durationMs: number;
  /** Start of the underlying incident; protects current-trial statistics from late completions. */
  startedAt?: number;
  observedAt?: number;
}
export interface RecoveryExperimentBucketTotal {
  episodes: number;
  recovered: number;
}
export interface RecoveryExperimentSwitch {
  from: string;
  to: string;
  startedAt: number;
  finishedAt: number;
  reason: "zero-success" | "low-yield" | "enough-samples" | "max-window";
  closedEpisodes: number;
  recoveredEpisodes: number;
}
export interface RecoveryEpisodeAssignment {
  armId: string;
  busyBucket: string;
  startedAt: number;
}
export interface RecoveryExperimentState {
  version: 1;
  enabled: boolean;
  armId: string;
  armStartedAt: number;
  /** Start of the current enabled period; older episodes are not imported. */
  enabledAt?: number;
  lastEvaluatedAt: number;
  samples: RecoveryExperimentSample[];
  seenIds: string[];
  round: number;
  exposureMs?: Record<string, number>;
  /** Measured recovery-opportunity exposure by arm and workload cohort. */
  exposureByBucketMs?: Record<string, number>;
  /** First observation after cohort exposure accounting was introduced. */
  bucketExposureSince?: number;
  /** Cumulative outcomes independent of the bounded recent sample window. */
  bucketTotals?: Record<string, RecoveryExperimentBucketTotal>;
  /** Lane-conditioned exposure prevents red-heavy arms outperforming orange-heavy arms by case mix. */
  laneExposureSince?: number;
  laneExposureMs?: Record<string, number>;
  laneTotals?: Record<string, RecoveryExperimentBucketTotal>;
  switchHistory?: RecoveryExperimentSwitch[];
  /** Pending episode -> experimental arm captured at recovery onset, not its completion. */
  episodeAssignments?: Record<string, RecoveryEpisodeAssignment>;
  missingExposureMs?: number;
  noOpportunityMs?: number;
}
const KEY = "t3code:chatgpt:recovery-experiment:v1";
const EVENT = "chatgpt-recovery-experiment-changed";
const STATS_EVENT = "chatgpt-recovery-experiment-stats-updated";
const MAX_SAMPLES = 1500;
const MIN_ARM_MS = 20 * 60_000;
const MAX_ARM_MS = 60 * 60_000;
const MIN_CLOSED = 5;
const fresh = (): RecoveryExperimentState => ({
  version: 1,
  enabled: false,
  armId: RECOVERY_EXPERIMENT_ARMS[0]!.id,
  armStartedAt: 0,
  enabledAt: 0,
  lastEvaluatedAt: 0,
  samples: [],
  seenIds: [],
  round: 0,
  exposureMs: {},
  exposureByBucketMs: {},
  bucketExposureSince: 0,
  bucketTotals: {},
  laneExposureSince: 0,
  laneExposureMs: {},
  laneTotals: {},
  switchHistory: [],
  episodeAssignments: {},
  missingExposureMs: 0,
  noOpportunityMs: 0,
});
const bucket = (active: number | null) =>
  active === null ? "unknown" : active >= 8 ? "8+" : active >= 4 ? "4-7" : "0-3";

/**
 * Guest activity is only a workload proxy. Red/orange/unknown tabs may still
 * be generating on ChatGPT's server; treating those as idle would falsely
 * credit aggressive recovery strategies with a low-load cohort.
 */
export function observedRecoveryWorkload(
  snapshots: readonly { activity?: string; observedAt?: number }[],
  now: number,
  knownSessionCount = snapshots.length,
): number | null {
  if (knownSessionCount < 1 || !Number.isSafeInteger(knownSessionCount)) return null;
  let confirmedWorking = 0;
  let uncertain = Math.max(0, knownSessionCount - snapshots.length);
  for (const snapshot of snapshots) {
    const fresh =
      typeof snapshot.observedAt === "number" &&
      Number.isFinite(snapshot.observedAt) &&
      snapshot.observedAt <= now &&
      now - snapshot.observedAt <= 120_000;
    if (!fresh || (snapshot.activity !== "idle" && snapshot.activity !== "working")) {
      // A missing, stale, red or orange guest can still be generating server-side.
      uncertain++;
    } else if (snapshot.activity === "working") confirmedWorking++;
  }
  // Only assign a measured cohort when ALL possible levels of unseen work
  // fall into the same coarse load bucket. Do not turn unknown into "idle".
  return bucket(confirmedWorking) === bucket(confirmedWorking + uncertain)
    ? confirmedWorking
    : null;
}
const validArm = (id: unknown) => RECOVERY_EXPERIMENT_ARMS.some((a) => a.id === id);
const validCohortKey = (key: string) =>
  RECOVERY_EXPERIMENT_ARMS.some((arm) =>
    ["0-3", "4-7", "8+", "unknown"].some((cohort) => key === `${arm.id}|${cohort}`),
  );
const validLaneKey = (key: string) =>
  RECOVERY_EXPERIMENT_ARMS.some((arm) =>
    ["red", "orange"].some((lane) =>
      ["0-3", "4-7", "8+", "unknown"].some((cohort) => key === `${arm.id}|${lane}|${cohort}`),
    ),
  );
const validTotal = (value: unknown): value is RecoveryExperimentBucketTotal => {
  if (!value || typeof value !== "object") return false;
  const total = value as Partial<RecoveryExperimentBucketTotal>;
  return (
    Number.isSafeInteger(total.episodes) &&
    Number.isSafeInteger(total.recovered) &&
    (total.episodes ?? -1) >= 0 &&
    (total.recovered ?? -1) >= 0 &&
    (total.recovered ?? 0) <= (total.episodes ?? 0)
  );
};

export function readRecoveryExperiment(storage?: Storage): RecoveryExperimentState {
  try {
    const local = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!local) return fresh();
    const value: unknown = JSON.parse(local.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return fresh();
    const v = value as Partial<RecoveryExperimentState>;
    if (
      v.version !== 1 ||
      typeof v.enabled !== "boolean" ||
      !validArm(v.armId) ||
      !Number.isFinite(v.armStartedAt) ||
      !Number.isSafeInteger(v.round) ||
      !Array.isArray(v.samples) ||
      !Array.isArray(v.seenIds)
    )
      return fresh();
    return {
      version: 1,
      enabled: v.enabled,
      armId: v.armId!,
      armStartedAt: v.armStartedAt!,
      enabledAt:
        typeof v.enabledAt === "number" && Number.isFinite(v.enabledAt) && v.enabledAt >= 0
          ? v.enabledAt
          : 0,
      lastEvaluatedAt: Number.isFinite(v.lastEvaluatedAt) ? v.lastEvaluatedAt! : 0,
      samples: v.samples
        .filter(
          (s) =>
            s &&
            typeof s.episodeId === "string" &&
            validArm(s.armId) &&
            ["0-3", "4-7", "8+", "unknown"].includes(s.busyBucket) &&
            typeof s.recovered === "boolean" &&
            Number.isFinite(s.durationMs) &&
            (s.startedAt === undefined ||
              (typeof s.startedAt === "number" &&
                Number.isFinite(s.startedAt) &&
                s.startedAt >= 0)),
        )
        .slice(-MAX_SAMPLES),
      seenIds: v.seenIds
        .filter((id): id is string => typeof id === "string")
        .slice(-MAX_SAMPLES * 2),
      round: Math.max(0, v.round!),
      exposureMs: Object.fromEntries(
        Object.entries(v.exposureMs ?? {}).filter(
          ([id, ms]) => validArm(id) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0,
        ),
      ),
      bucketExposureSince:
        typeof v.bucketExposureSince === "number" &&
        Number.isFinite(v.bucketExposureSince) &&
        v.bucketExposureSince >= 0
          ? v.bucketExposureSince
          : 0,
      exposureByBucketMs: Object.fromEntries(
        Object.entries(v.exposureByBucketMs ?? {}).filter(
          ([key, ms]) =>
            RECOVERY_EXPERIMENT_ARMS.some((arm) =>
              ["0-3", "4-7", "8+", "unknown"].some((cohort) => key === `${arm.id}|${cohort}`),
            ) &&
            typeof ms === "number" &&
            Number.isFinite(ms) &&
            ms >= 0,
        ),
      ),
      ...(v.bucketTotals === undefined
        ? {}
        : {
            bucketTotals: Object.fromEntries(
              Object.entries(v.bucketTotals).filter(
                ([key, totals]) => validCohortKey(key) && validTotal(totals),
              ),
            ),
          }),
      laneExposureSince:
        typeof v.laneExposureSince === "number" &&
        Number.isFinite(v.laneExposureSince) &&
        v.laneExposureSince >= 0
          ? v.laneExposureSince
          : 0,
      laneExposureMs: Object.fromEntries(
        Object.entries(v.laneExposureMs ?? {}).filter(
          ([key, ms]) =>
            validLaneKey(key) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0,
        ),
      ),
      laneTotals: Object.fromEntries(
        Object.entries(v.laneTotals ?? {}).filter(
          ([key, total]) => validLaneKey(key) && validTotal(total),
        ),
      ),
      switchHistory: (Array.isArray(v.switchHistory) ? v.switchHistory : [])
        .filter(
          (s): s is RecoveryExperimentSwitch =>
            !!s &&
            validArm(s.from) &&
            validArm(s.to) &&
            Number.isFinite(s.startedAt) &&
            Number.isFinite(s.finishedAt) &&
            s.finishedAt >= s.startedAt &&
            ["zero-success", "low-yield", "enough-samples", "max-window"].includes(s.reason) &&
            Number.isSafeInteger(s.closedEpisodes) &&
            s.closedEpisodes >= 0 &&
            Number.isSafeInteger(s.recoveredEpisodes) &&
            s.recoveredEpisodes >= 0 &&
            s.recoveredEpisodes <= s.closedEpisodes,
        )
        .slice(-100),
      episodeAssignments: Object.fromEntries(
        Object.entries(v.episodeAssignments ?? {})
          .filter(
            ([id, a]) =>
              typeof id === "string" &&
              id.length <= 128 &&
              !!a &&
              typeof a === "object" &&
              validArm(a.armId) &&
              ["0-3", "4-7", "8+", "unknown"].includes(a.busyBucket) &&
              typeof a.startedAt === "number" &&
              Number.isFinite(a.startedAt) &&
              a.startedAt >= 0,
          )
          .slice(-MAX_SAMPLES),
      ),
      missingExposureMs:
        typeof v.missingExposureMs === "number" &&
        Number.isFinite(v.missingExposureMs) &&
        v.missingExposureMs >= 0
          ? v.missingExposureMs
          : 0,
      noOpportunityMs:
        typeof v.noOpportunityMs === "number" &&
        Number.isFinite(v.noOpportunityMs) &&
        v.noOpportunityMs >= 0
          ? v.noOpportunityMs
          : 0,
    };
  } catch {
    return fresh();
  }
}
export function saveRecoveryExperiment(state: RecoveryExperimentState, storage?: Storage): boolean {
  try {
    const local = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!local) return false;
    const previous = readRecoveryExperiment(local);
    local.setItem(KEY, JSON.stringify(state));
    if (typeof window === "undefined") return true;
    // A 30-second metrics sample must NOT reschedule background recovery:
    // the coordinator listens to EVENT for actual cadence/enable changes.
    const cadenceChanged = previous.enabled !== state.enabled || previous.armId !== state.armId;
    window.dispatchEvent(new window.Event(cadenceChanged ? EVENT : STATS_EVENT));
    return true;
  } catch {
    // Full or locked storage must not crash the host or recovery coordinator.
    // The old result remains authoritative until a successful persistence.
    return false;
  }
}
export function subscribeRecoveryExperiment(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener(STATS_EVENT, listener);
  // Ignore unrelated session/draft storage churn across T3 windows.
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener(STATS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
export function toggledRecoveryExperiment(
  state: RecoveryExperimentState,
  enabled: boolean,
  now: number,
): RecoveryExperimentState {
  const starting = enabled && !state.enabled;
  return {
    ...state,
    enabled,
    armStartedAt: starting ? now : state.armStartedAt,
    ...(starting
      ? { enabledAt: now }
      : state.enabledAt === undefined
        ? {}
        : { enabledAt: state.enabledAt }),
    // A late completion from a previous enabled period must never be treated
    // as a new trial, even if its original cadence ID was reused.
    ...(starting
      ? { episodeAssignments: {} }
      : state.episodeAssignments === undefined
        ? {}
        : { episodeAssignments: state.episodeAssignments }),
    lastEvaluatedAt: now,
  };
}
export function setRecoveryExperimentEnabled(enabled: boolean, now = Date.now()) {
  saveRecoveryExperiment(toggledRecoveryExperiment(readRecoveryExperiment(), enabled, now));
}
/** A user's global pause stops recovery opportunities; it must not score an
 * arm as failed or consume its comparison window while no retries can run. */
export function suspendRecoveryExperiment(
  state: RecoveryExperimentState,
  now: number,
): RecoveryExperimentState {
  if (!state.enabled || now <= state.lastEvaluatedAt) return state;
  const pausedMs = now - state.lastEvaluatedAt;
  return {
    ...state,
    lastEvaluatedAt: now,
    armStartedAt: state.armStartedAt + pausedMs,
    // An incident active across a manual pause has no continuous automatic
    // treatment. Do not credit its eventual outcome to an experimental arm.
    episodeAssignments: {},
    missingExposureMs: (state.missingExposureMs ?? 0) + pausedMs,
  };
}

export function currentRecoveryExperimentArm(state: RecoveryExperimentState) {
  return RECOVERY_EXPERIMENT_ARMS.find((a) => a.id === state.armId) ?? RECOVERY_EXPERIMENT_ARMS[0]!;
}
function totalsFromSamples(samples: readonly RecoveryExperimentSample[], since: number) {
  const totals: Record<string, RecoveryExperimentBucketTotal> = {};
  if (since <= 0) return totals;
  for (const sample of samples) {
    if (
      !validArm(sample.armId) ||
      typeof sample.observedAt !== "number" ||
      sample.observedAt < since
    )
      continue;
    const id = `${sample.armId}|${sample.busyBucket}`;
    if (!validCohortKey(id)) continue;
    const previous = totals[id] ?? { episodes: 0, recovered: 0 };
    totals[id] = {
      episodes: previous.episodes + 1,
      recovered: previous.recovered + (sample.recovered ? 1 : 0),
    };
  }
  return totals;
}
export function recoveryExperimentStatistics(state: RecoveryExperimentState) {
  const totals =
    state.bucketTotals ?? totalsFromSamples(state.samples, state.bucketExposureSince ?? 0);
  return RECOVERY_EXPERIMENT_ARMS.map((arm) => {
    const records = state.samples.filter((s) => s.armId === arm.id);
    const recovered = records.filter((s) => s.recovered);
    const armTotals = ["0-3", "4-7", "8+", "unknown"].map(
      (cohort) => totals[`${arm.id}|${cohort}`] ?? { episodes: 0, recovered: 0 },
    );
    const allEpisodes = armTotals.reduce((sum, item) => sum + item.episodes, 0);
    const allRecovered = armTotals.reduce((sum, item) => sum + item.recovered, 0);
    const armExposureMs = ["0-3", "4-7", "8+", "unknown"].reduce(
      (sum, cohort) => sum + (state.exposureByBucketMs?.[`${arm.id}|${cohort}`] ?? 0),
      0,
    );
    const durations = recovered.map((s) => s.durationMs).sort((a, b) => a - b);
    return {
      arm: arm.id,
      episodes: allEpisodes,
      recovered: allRecovered,
      observedHours: armExposureMs / 3_600_000,
      recoveredPerHour:
        allEpisodes >= 3 && armExposureMs >= 5 * 60_000
          ? (allRecovered * 3_600_000) / armExposureMs
          : null,
      observedRecoveryRate: allEpisodes ? allRecovered / allEpisodes : null,
      medianMs: durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null,
      byCategory: (["red", "orange"] as const).map((category) => ({
        category,
        attempts: records.filter((s) => s.category === category).length,
        recovered: recovered.filter((s) => s.category === category).length,
      })),
      laneBuckets: (["red", "orange"] as const).flatMap((category) =>
        ["0-3", "4-7", "8+", "unknown"].map((busyBucket) => {
          const sample = state.laneTotals?.[`${arm.id}|${category}|${busyBucket}`] ?? {
            episodes: 0,
            recovered: 0,
          };
          const exposure = state.laneExposureMs?.[`${arm.id}|${category}|${busyBucket}`] ?? 0;
          return {
            category,
            busyBucket,
            episodes: sample.episodes,
            recovered: sample.recovered,
            observedHours: exposure / 3_600_000,
            recoveredPerHour:
              sample.episodes >= 3 && exposure >= 5 * 60_000
                ? (sample.recovered * 3_600_000) / exposure
                : null,
          };
        }),
      ),
      buckets: ["0-3", "4-7", "8+", "unknown"].map((b) => {
        const aggregate = totals[`${arm.id}|${b}`] ?? { episodes: 0, recovered: 0 };
        const count = aggregate.episodes;
        const recoveredCount = aggregate.recovered;
        const exposureMs =
          (state.bucketExposureSince ?? 0) > 0
            ? (state.exposureByBucketMs?.[`${arm.id}|${b}`] ?? 0)
            : 0;
        return {
          busyBucket: b,
          count,
          recovered: recoveredCount,
          observedHours: exposureMs / 3_600_000,
          recoveredPerHour:
            count >= 3 && exposureMs >= 5 * 60_000
              ? (recoveredCount * 3_600_000) / exposureMs
              : null,
        };
      }),
    };
  });
}
/** Portable, aggregate-only diagnostics. No session identifiers, chat content,
 * drafts, URLs, or individual episodes are included in the copied report. */
export function recoveryExperimentSummaryReport(state: RecoveryExperimentState): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      enabled: state.enabled,
      currentArm: state.armId,
      round: state.round,
      observedCohortSince: state.bucketExposureSince ?? null,
      missingObservationMinutes: Math.round((state.missingExposureMs ?? 0) / 60_000),
      noOpportunityMinutes: Math.round((state.noOpportunityMs ?? 0) / 60_000),
      method: "Closed, fully observed automatic recovery episodes only; workload is a proxy.",
      arms: recoveryExperimentStatistics(state),
      recentTrials: (state.switchHistory ?? []).slice(-20),
    },
    null,
    2,
  );
}
/** Use recorded trial boundaries for episodes first encountered after closing.
 * Their original trial, not the currently running cadence, gets the outcome. */
function armAtEpisodeStart(
  state: RecoveryExperimentState,
  startedAt: number,
  currentArmStart: number,
): string | null {
  if (startedAt >= currentArmStart) return state.armId;
  for (const trial of [...(state.switchHistory ?? [])].reverse()) {
    if (startedAt >= trial.startedAt && startedAt < trial.finishedAt) return trial.from;
  }
  return null; // Unknown historical attribution must be censored, never guessed.
}

/** Only closed, fully observed AUTOMATIC episodes count. Red/orange can represent
 * active server-side work, so active/unknown/partial observations are censored.
 * This optimizes observed recovery, NOT causal success or actual account load. */
export function advanceRecoveryExperiment(
  state: RecoveryExperimentState,
  episodes: readonly RecoveryEpisode[],
  activeGuestCount: number | null,
  now: number,
  hasRecoveryOpportunity = true,
  opportunityLanes: readonly RecoveryCategory[] = [],
): RecoveryExperimentState {
  if (!state.enabled) return state;
  const seen = new Set(state.seenIds);
  const elapsedSinceObservation =
    state.lastEvaluatedAt > 0 ? Math.max(0, now - state.lastEvaluatedAt) : 0;
  // A suspended renderer is unobserved exposure, not a valid experiment.
  // Count at most one 30-second sampler interval plus scheduling jitter.
  const observedDelta = Math.min(120_000, elapsedSinceObservation);
  const exposureMs = {
    ...state.exposureMs,
    [state.armId]:
      (state.exposureMs?.[state.armId] ?? 0) + (hasRecoveryOpportunity ? observedDelta : 0),
  };
  // Legacy samples predate cohort exposure instrumentation. Start clean
  // instead of dividing years of recoveries by minutes of newly measured time.
  const bucketExposureSince =
    (state.bucketExposureSince ?? 0) > 0 ? state.bucketExposureSince! : now - observedDelta;
  const previousBucketExposure =
    (state.bucketExposureSince ?? 0) > 0 ? (state.exposureByBucketMs ?? {}) : {};
  const cohortKey = `${state.armId}|${bucket(activeGuestCount)}`;
  const exposureByBucketMs = {
    ...previousBucketExposure,
    [cohortKey]:
      (previousBucketExposure[cohortKey] ?? 0) + (hasRecoveryOpportunity ? observedDelta : 0),
  };
  const laneExposureSince =
    (state.laneExposureSince ?? 0) > 0
      ? state.laneExposureSince!
      : opportunityLanes.length
        ? now - observedDelta
        : 0;
  const laneExposureMs = { ...((state.laneExposureSince ?? 0) > 0 ? state.laneExposureMs : {}) };
  for (const lane of new Set(opportunityLanes)) {
    const key = `${state.armId}|${lane}|${bucket(activeGuestCount)}`;
    laneExposureMs[key] = (laneExposureMs[key] ?? 0) + (hasRecoveryOpportunity ? observedDelta : 0);
  }
  const missingExposureMs =
    (state.missingExposureMs ?? 0) + Math.max(0, elapsedSinceObservation - observedDelta);
  const noOpportunityMs =
    (state.noOpportunityMs ?? 0) + (hasRecoveryOpportunity ? 0 : observedDelta);
  // Inactive/no-failure intervals and unobserved renderer sleeps cannot
  // contribute an experimental trial or consume its 20–60 minute window.
  const effectiveArmStart =
    state.armStartedAt +
    (elapsedSinceObservation - observedDelta) +
    (hasRecoveryOpportunity ? 0 : observedDelta);
  const samples = [...state.samples];
  const bucketTotals = {
    ...(state.bucketTotals ?? totalsFromSamples(state.samples, bucketExposureSince)),
  };
  const laneTotals = { ...state.laneTotals };
  const retainedEpisodeIds = new Set(episodes.map((episode) => episode.id));
  const episodeAssignments = Object.fromEntries(
    Object.entries(state.episodeAssignments ?? {}).filter(([id]) => retainedEpisodeIds.has(id)),
  ) as Record<string, RecoveryEpisodeAssignment>;
  let switchHistory = state.switchHistory ?? [];
  const newIds: string[] = [];
  for (const episode of episodes) {
    if (
      seen.has(episode.id) ||
      episode.source !== "automatic" ||
      episode.partial ||
      episode.startedAt > now ||
      (state.enabledAt && episode.startedAt < state.enabledAt)
    )
      continue;
    const prior = episodeAssignments[episode.id];
    const assignedArm =
      prior?.armId ?? armAtEpisodeStart(state, episode.startedAt, effectiveArmStart);
    if (!assignedArm) continue;
    if (episode.outcome === "active") {
      // Capture the arm and workload when a recovery first becomes observable.
      // A later completion must not be credited to a different cadence.
      if (!prior)
        episodeAssignments[episode.id] = {
          armId: assignedArm,
          busyBucket: assignedArm === state.armId ? bucket(activeGuestCount) : "unknown",
          startedAt: episode.startedAt,
        };
      continue;
    }
    if (episode.closedAt === null) continue;
    if (!["recovered", "failed"].includes(episode.outcome)) {
      // Closed UNKNOWN cannot establish a recovery result. Retire its
      // pending assignment rather than retaining it until ledger eviction.
      delete episodeAssignments[episode.id];
      seen.add(episode.id);
      newIds.push(episode.id);
      continue;
    }
    // Incidents resolved without any recovery action are spontaneous, not
    // evidence that a particular retry cadence caused a recovery.
    if (episode.attemptCount === 0) {
      delete episodeAssignments[episode.id];
      seen.add(episode.id);
      newIds.push(episode.id);
      continue;
    }
    delete episodeAssignments[episode.id];
    const assignedBucket = prior?.busyBucket ?? "unknown"; // No onset observation: completion-time workload is not onset workload.
    newIds.push(episode.id);
    seen.add(episode.id);
    samples.push({
      episodeId: episode.id,
      armId: assignedArm,
      busyBucket: assignedBucket,
      category: episode.category,
      recovered: episode.outcome === "recovered",
      attemptCount: episode.attemptCount,
      durationMs: Math.max(0, episode.closedAt - episode.startedAt),
      startedAt: episode.startedAt,
      observedAt: now,
    });
    const aggregateKey = `${assignedArm}|${assignedBucket}`;
    const previous = bucketTotals[aggregateKey] ?? { episodes: 0, recovered: 0 };
    bucketTotals[aggregateKey] = {
      episodes: previous.episodes + 1,
      recovered: previous.recovered + (episode.outcome === "recovered" ? 1 : 0),
    };
    const crossedAnotherPolicy = switchHistory.some(
      (trial) => trial.finishedAt > episode.startedAt && trial.finishedAt < episode.closedAt!,
    );
    // If an incident spans multiple policy arms, the final outcome is still
    // recorded descriptively but must not choose the next experimental winner.
    if (laneExposureSince > 0 && episode.startedAt >= laneExposureSince && !crossedAnotherPolicy) {
      const laneKey = `${assignedArm}|${episode.category}|${assignedBucket}`;
      const prevLane = laneTotals[laneKey] ?? { episodes: 0, recovered: 0 };
      laneTotals[laneKey] = {
        episodes: prevLane.episodes + 1,
        recovered: prevLane.recovered + (episode.outcome === "recovered" ? 1 : 0),
      };
    }
    // A trial may finish before some episodes started under its cadence do.
    // Amend that trial’s aggregate summary without shifting its boundaries.
    const trialIndex = switchHistory.findIndex(
      (trial) =>
        trial.from === assignedArm &&
        episode.startedAt >= trial.startedAt &&
        episode.startedAt < trial.finishedAt,
    );
    if (trialIndex >= 0)
      switchHistory = switchHistory.map((trial, index) =>
        index === trialIndex
          ? {
              ...trial,
              closedEpisodes: trial.closedEpisodes + 1,
              recoveredEpisodes:
                trial.recoveredEpisodes + (episode.outcome === "recovered" ? 1 : 0),
            }
          : trial,
      );
  }
  let armId = state.armId;
  let round = state.round;
  let armStartedAt = state.armStartedAt;
  armStartedAt = effectiveArmStart;
  const elapsed = now - effectiveArmStart;
  const armSamples = samples.filter(
    (s) =>
      s.armId === state.armId &&
      (s.observedAt ?? 0) >= state.armStartedAt &&
      (s.startedAt === undefined || s.startedAt >= state.armStartedAt),
  );
  // Rotate through every arm, including temporarily poor performers. Avoid
  // choosing a winner on a handful of recoveries or a different load mix.
  const rapidFailure =
    elapsed >= 5 * 60_000 && armSamples.length >= 8 && armSamples.every((s) => !s.recovered);
  const rapidLowYield =
    elapsed >= 10 * 60_000 &&
    armSamples.length >= 10 &&
    armSamples.filter((s) => s.recovered).length / armSamples.length <= 0.1;
  if (
    rapidFailure ||
    rapidLowYield ||
    elapsed >= MAX_ARM_MS ||
    (elapsed >= MIN_ARM_MS && armSamples.length >= MIN_CLOSED)
  ) {
    round++;
    // First gather comparable observations for every arm. Once sufficiently
    // sampled, exploit the best observed arm three rounds out of four while
    // continuing to revisit the others (including previously poor arms).
    const newCohortSamples = samples.filter(
      (s) => typeof s.observedAt === "number" && s.observedAt >= bucketExposureSince,
    );
    const laneMode = laneExposureSince > 0;
    const knownCohorts = ["0-3", "4-7", "8+"];
    const candidates = laneMode
      ? (["red", "orange"] as const).flatMap((lane) =>
          knownCohorts.map((cohort) => `${lane}|${cohort}`),
        )
      : knownCohorts;
    const totalFor = (arm: string, cohort: string) =>
      (laneMode ? laneTotals : bucketTotals)[`${arm}|${cohort}`] ?? { episodes: 0, recovered: 0 };
    const exposureFor = (arm: string, cohort: string) =>
      (laneMode ? laneExposureMs : exposureByBucketMs)[`${arm}|${cohort}`] ?? 0;
    // Scheme experiments must have a shared, directly observed orange
    // workload before their effectiveness can be compared. Until then,
    // optimize timings only and keep scheme variants in exploration.
    const schemeEvidence =
      laneMode &&
      knownCohorts.some((cohort) =>
        RECOVERY_EXPERIMENT_ARMS.every(
          (arm) =>
            totalFor(arm.id, `orange|${cohort}`).episodes >= 3 &&
            exposureFor(arm.id, `orange|${cohort}`) >= 5 * 60_000,
        ),
      );
    // Earlier experiments had a reload-stop-continue baseline. Since the
    // conservative rollout switched every arm to reload-only, that filter
    // can be EMPTY. Never choose a winner from an empty scored list.
    const schemeBaselines = RECOVERY_EXPERIMENT_ARMS.filter(
      (arm) => arm.orangeStrategy === "reload-stop-continue",
    );
    const comparableArms =
      laneMode && !schemeEvidence && schemeBaselines.length > 0
        ? schemeBaselines
        : RECOVERY_EXPERIMENT_ARMS;
    const allSampled = comparableArms.every(
      (arm) =>
        candidates.reduce((total, cohort) => total + totalFor(arm.id, cohort).episodes, 0) >= 8,
    );
    // Only compare the same red/orange lane AND the same account-load bucket.
    const matchedCohorts = candidates.filter((cohort) =>
      comparableArms.every(
        (arm) =>
          totalFor(arm.id, cohort).episodes >= 3 && exposureFor(arm.id, cohort) >= 5 * 60_000,
      ),
    );
    // Exploration is every fourth round. Its index must advance across
    // exploration rounds, not remain permanently pinned to the first arm.
    const exploreIndex = Math.max(0, Math.floor(round / 4) - 1) % RECOVERY_EXPERIMENT_ARMS.length;
    let next =
      RECOVERY_EXPERIMENT_ARMS[
        allSampled && matchedCohorts.length > 0 && round % 4 === 0
          ? exploreIndex
          : round % RECOVERY_EXPERIMENT_ARMS.length
      ]!;
    if (allSampled && matchedCohorts.length > 0 && round % 4 !== 0) {
      const scored = comparableArms
        .map((arm) => {
          const byBucket = matchedCohorts.map((cohort) => totalFor(arm.id, cohort));
          const present = byBucket.filter((b) => b.episodes >= 3);
          // Equal-weight comparable-load cohorts; never reward a strategy merely
          // because it mostly ran while the account was idle. Optimize recovered
          // sessions/hour with a success-rate penalty for wasted attempts.
          const rate = present.length
            ? present.reduce((sum, group, index) => {
                const cohort = matchedCohorts[index]!;
                const recovered = group.recovered;
                const hours = exposureFor(arm.id, cohort) / 3_600_000;
                return (
                  sum +
                  (recovered / Math.max(hours, 0.001)) * (0.5 + (recovered / group.episodes) * 0.5)
                );
              }, 0) / present.length
            : 0;
          const medianDuration = (() => {
            const times = newCohortSamples
              .filter((s) => s.armId === arm.id && s.recovered)
              .map((s) => s.durationMs)
              .sort((a, b) => a - b);
            return times.length ? times[Math.floor((times.length - 1) / 2)]! : 3_600_000;
          })();
          // Avoid a fast arm with poor recovery success winning. Duration
          // only breaks ties between comparably successful strategies.
          return { arm, rate, medianDuration };
        })
        .sort((a, b) => b.rate - a.rate || a.medianDuration - b.medianDuration);
      // A poorly-performing arm still gets a future exploration turn.
      next = scored[0]!.arm;
    }
    // Fail closed on weak evidence: experiment with longer waits, never more
    // aggressive recovery, until at least ten fully observed outcomes show
    // >=30% successful episodes under the current arm.
    const verifiedAttempts = armSamples.reduce(
      (sum, sample) => sum + (sample.attemptCount ?? 0),
      0,
    );
    const successRate = verifiedAttempts
      ? armSamples.filter((s) => s.recovered && s.attemptCount).length / verifiedAttempts
      : 0;
    if (verifiedAttempts < 10 || successRate < 0.3) {
      const current = currentRecoveryExperimentArm(state);
      next =
        RECOVERY_EXPERIMENT_ARMS.filter((arm) => arm.perSessionSeconds >= current.perSessionSeconds)
          .sort((a, b) => a.perSessionSeconds - b.perSessionSeconds)
          .find((arm) => arm.perSessionSeconds > current.perSessionSeconds) ??
        RECOVERY_EXPERIMENT_ARMS.reduce((a, b) =>
          a.perSessionSeconds > b.perSessionSeconds ? a : b,
        );
    }
    armId = next.id;
    const reason: RecoveryExperimentSwitch["reason"] = rapidFailure
      ? "zero-success"
      : rapidLowYield
        ? "low-yield"
        : elapsed >= MAX_ARM_MS
          ? "max-window"
          : "enough-samples";
    // A failed slowest arm must keep accumulating evidence instead of repeatedly resetting its trial.
    if (armId !== state.armId) {
      switchHistory = [
        ...switchHistory,
        {
          from: state.armId,
          to: armId,
          startedAt: state.armStartedAt,
          finishedAt: now,
          reason,
          closedEpisodes: armSamples.length,
          recoveredEpisodes: armSamples.filter((s) => s.recovered).length,
        },
      ].slice(-100);
    }
    if (armId !== state.armId) armStartedAt = now;
  }
  return {
    ...state,
    armId,
    round,
    armStartedAt,
    lastEvaluatedAt: now,
    exposureMs,
    exposureByBucketMs,
    bucketExposureSince,
    bucketTotals,
    laneExposureSince,
    laneExposureMs,
    laneTotals,
    switchHistory,
    episodeAssignments: Object.fromEntries(Object.entries(episodeAssignments).slice(-MAX_SAMPLES)),
    missingExposureMs,
    noOpportunityMs,
    samples: samples.slice(-MAX_SAMPLES),
    seenIds: [...state.seenIds, ...newIds].slice(-MAX_SAMPLES * 2),
  };
}
