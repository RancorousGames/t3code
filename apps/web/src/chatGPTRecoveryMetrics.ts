/** Content-free episode accounting. Callers must provide verified outcomes, never reload completion. */
export type RecoveryCategory = "red" | "orange";
export type RecoveryCause = "load-failure" | "interrupted" | "stalled" | "unknown";
export type RecoveryOutcome = "active" | "recovered" | "failed" | "unknown";
/** Explicit provenance; legacy rows without source are NOT presumed automatic. */
export type RecoverySource = "automatic" | "manual" | "lost-route";
export interface RecoveryEpisode {
  id: string;
  sessionId: string;
  category: RecoveryCategory;
  cause: RecoveryCause;
  source?: RecoverySource;
  startedAt: number;
  updatedAt: number;
  attemptCount: number;
  actions?: { reload: number; stop: number; continue: number };
  outcome: RecoveryOutcome;
  closedAt: number | null;
  partial: boolean;
}
interface ObservationCoverage {
  firstProbeAt: number;
  lastProbeAt: number;
  gapCount: number;
  missedMs: number;
  gaps: { from: number; to: number }[];
  retiredThrough: number | null;
}
interface Ledger {
  version: 1;
  since: number;
  dropped: number;
  droppedActive: number;
  retiredThrough: number | null;
  episodes: RecoveryEpisode[];
  observation?: ObservationCoverage;
}
export const MAX_RECOVERY_EPISODES = 500;
export const MAX_OBSERVATION_GAPS = 100;
/** If a caller cannot probe within this interval, the unobserved time is censored. */
export const MAX_OBSERVATION_INTERVAL_MS = 5 * 60_000;
const key = (environmentId: string) =>
  `t3code:chatgpt-browser:recovery-metrics:v1:${environmentId}`;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const counter = (value: unknown): value is number =>
  timestamp(value) && Number.isSafeInteger(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function episode(value: unknown): RecoveryEpisode | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    !identifier(v.id) ||
    !identifier(v.sessionId) ||
    !["red", "orange"].includes(String(v.category)) ||
    !["load-failure", "interrupted", "stalled", "unknown"].includes(String(v.cause)) ||
    (v.source !== undefined && !["automatic", "manual", "lost-route"].includes(String(v.source))) ||
    !timestamp(v.startedAt) ||
    !timestamp(v.updatedAt) ||
    v.updatedAt < v.startedAt ||
    !counter(v.attemptCount) ||
    (v.actions !== undefined &&
      (!v.actions ||
        typeof v.actions !== "object" ||
        !["reload", "stop", "continue"].every((k) =>
          counter((v.actions as Record<string, unknown>)[k]),
        ) ||
        ["reload", "stop", "continue"].reduce(
          (total, k) => total + Number((v.actions as Record<string, unknown>)[k]),
          0,
        ) > v.attemptCount)) ||
    !["active", "recovered", "failed", "unknown"].includes(String(v.outcome)) ||
    typeof v.partial !== "boolean" ||
    (v.outcome === "active"
      ? v.closedAt !== null
      : !timestamp(v.closedAt) || v.closedAt < v.startedAt || v.closedAt > v.updatedAt)
  )
    return null;
  // Reconstruct explicitly: unknown fields, URLs and free-form details are never retained.
  return {
    id: v.id,
    sessionId: v.sessionId,
    category: v.category as RecoveryCategory,
    cause: v.cause as RecoveryCause,
    ...(v.source === undefined ? {} : { source: v.source as RecoverySource }),
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
    attemptCount: v.attemptCount,
    ...(v.actions === undefined
      ? {}
      : {
          actions: {
            reload: (v.actions as NonNullable<RecoveryEpisode["actions"]>).reload,
            stop: (v.actions as NonNullable<RecoveryEpisode["actions"]>).stop,
            continue: (v.actions as NonNullable<RecoveryEpisode["actions"]>).continue,
          },
        }),
    outcome: v.outcome as RecoveryOutcome,
    closedAt: v.closedAt as number | null,
    partial: v.partial,
  };
}
export function readChatGPTRecoveryMetrics(environmentId: string) {
  try {
    const raw = localStorage.getItem(key(environmentId));
    if (raw === null) return { availability: "missing" as const, ledger: null };
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") throw new Error();
    const r = v as Record<string, unknown>;
    if (
      r.version !== 1 ||
      !timestamp(r.since) ||
      !counter(r.dropped) ||
      !counter(r.droppedActive) ||
      (r.retiredThrough !== null && !timestamp(r.retiredThrough)) ||
      !Array.isArray(r.episodes) ||
      r.episodes.length > MAX_RECOVERY_EPISODES
    )
      throw new Error();
    const episodes = r.episodes.map(episode);
    if (episodes.some((e) => !e) || new Set(episodes.map((e) => e!.id)).size !== episodes.length)
      throw new Error();
    const coverage = r.observation;
    if (coverage !== undefined) {
      if (!coverage || typeof coverage !== "object") throw new Error();
      const c = coverage as Record<string, unknown>;
      if (
        !timestamp(c.firstProbeAt) ||
        !timestamp(c.lastProbeAt) ||
        c.lastProbeAt < c.firstProbeAt ||
        !counter(c.gapCount) ||
        !counter(c.missedMs) ||
        (c.retiredThrough !== null && !timestamp(c.retiredThrough)) ||
        !Array.isArray(c.gaps) ||
        c.gaps.length > MAX_OBSERVATION_GAPS ||
        c.gapCount < c.gaps.length ||
        c.gaps.some(
          (gap) =>
            !gap ||
            typeof gap !== "object" ||
            !timestamp(gap.from) ||
            !timestamp(gap.to) ||
            gap.to <= gap.from ||
            gap.from < (c.firstProbeAt as number) ||
            gap.to > (c.lastProbeAt as number),
        )
      )
        throw new Error();
    }
    const ledger: Ledger = {
      version: 1,
      since: r.since,
      dropped: r.dropped,
      droppedActive: r.droppedActive,
      retiredThrough: r.retiredThrough as number | null,
      episodes: episodes as RecoveryEpisode[],
      ...(coverage === undefined
        ? {}
        : {
            observation: {
              firstProbeAt: (coverage as ObservationCoverage).firstProbeAt,
              lastProbeAt: (coverage as ObservationCoverage).lastProbeAt,
              gapCount: (coverage as ObservationCoverage).gapCount,
              missedMs: (coverage as ObservationCoverage).missedMs,
              retiredThrough: (coverage as ObservationCoverage).retiredThrough,
              gaps: (coverage as ObservationCoverage).gaps.map((g) => ({ from: g.from, to: g.to })),
            },
          }),
    };
    return { availability: "available" as const, ledger };
  } catch {
    return { availability: "unavailable" as const, ledger: null };
  }
}
/** Stable episode id/start survive remounts. attemptCount is the cumulative ordinal, not an increment.
 * Call only at actual attempt dispatch; duplicate observations and repeated ordinals are idempotent.
 * partial=true when observation began after the incident/attempt history became unknown.
 */
export function recordChatGPTRecoveryMetric(
  environmentId: string,
  input: RecoveryEpisode,
): boolean {
  const next = episode(input);
  if (!next) return false;
  const read = readChatGPTRecoveryMetrics(environmentId);
  // Do not overwrite corrupt/future schemas or silently reset observation coverage.
  if (read.availability === "unavailable") return false;
  const ledger: Ledger = read.ledger ?? {
    version: 1,
    since: next.startedAt,
    dropped: 0,
    droppedActive: 0,
    retiredThrough: null,
    episodes: [],
  };
  const index = ledger.episodes.findIndex((e) => e.id === next.id);
  if (index >= 0) {
    const old = ledger.episodes[index]!;
    if (
      old.sessionId !== next.sessionId ||
      old.startedAt !== next.startedAt ||
      old.category !== next.category ||
      old.cause !== next.cause ||
      old.source !== next.source ||
      (old.partial && !next.partial) ||
      next.updatedAt < old.updatedAt ||
      next.attemptCount < old.attemptCount ||
      (old.actions !== undefined &&
        (next.actions === undefined ||
          next.actions.reload < old.actions.reload ||
          next.actions.stop < old.actions.stop ||
          next.actions.continue < old.actions.continue))
    )
      return false;
    if (old.outcome !== "active") return JSON.stringify(old) === JSON.stringify(next);
    if (JSON.stringify(old) === JSON.stringify(next)) return true;
    ledger.episodes[index] = next;
  } else {
    if (ledger.retiredThrough !== null && next.startedAt <= ledger.retiredThrough) return false;
    ledger.episodes.push(next);
  }
  if (ledger.episodes.length > MAX_RECOVERY_EPISODES) {
    ledger.episodes.sort((a, b) => a.startedAt - b.startedAt);
    const removed = ledger.episodes.shift()!;
    ledger.retiredThrough = Math.max(ledger.retiredThrough ?? 0, removed.startedAt);
    ledger.dropped++;
    if (removed.outcome === "active") ledger.droppedActive++;
  }
  try {
    localStorage.setItem(key(environmentId), JSON.stringify(ledger));
    return true;
  } catch {
    return false;
  }
}
/** Persist a verified coordinator observation; call at startup and after each actual probe.
 * Gaps are missing observation, not proof of an error or successful recovery.
 * This does not inspect guests and never backfills previously unobserved history.
 */
export function recordChatGPTRecoveryObservation(
  environmentId: string,
  at: number,
  maximumIntervalMs = MAX_OBSERVATION_INTERVAL_MS,
): boolean {
  if (!timestamp(at) || !counter(maximumIntervalMs) || maximumIntervalMs === 0) return false;
  const read = readChatGPTRecoveryMetrics(environmentId);
  if (read.availability === "unavailable") return false;
  const ledger: Ledger = read.ledger ?? {
    version: 1,
    since: at,
    dropped: 0,
    droppedActive: 0,
    retiredThrough: null,
    episodes: [],
  };
  const observation = ledger.observation ?? {
    firstProbeAt: at,
    lastProbeAt: at,
    gapCount: 0,
    missedMs: 0,
    gaps: [],
    retiredThrough: null,
  };
  if (at < observation.lastProbeAt) return false;
  if (at - observation.lastProbeAt > maximumIntervalMs) {
    const gap = { from: observation.lastProbeAt, to: at };
    observation.gaps.push(gap);
    observation.gapCount++;
    observation.missedMs += at - observation.lastProbeAt;
    if (observation.gaps.length > MAX_OBSERVATION_GAPS) {
      const removed = observation.gaps.shift()!;
      observation.retiredThrough = Math.max(observation.retiredThrough ?? 0, removed.to);
    }
  }
  observation.lastProbeAt = at;
  ledger.observation = observation;
  try {
    localStorage.setItem(key(environmentId), JSON.stringify(ledger));
    return true;
  } catch {
    return false;
  }
}

function gapIntersects(e: RecoveryEpisode, coverage: ObservationCoverage): boolean {
  const end = e.closedAt ?? e.updatedAt;
  return (
    (coverage.retiredThrough !== null && e.startedAt <= coverage.retiredThrough) ||
    coverage.gaps.some((g) => e.startedAt < g.to && end > g.from)
  );
}

function eligible(e: RecoveryEpisode, coverage?: ObservationCoverage): boolean {
  return (
    !e.partial &&
    coverage !== undefined &&
    e.startedAt >= coverage.firstProbeAt &&
    e.updatedAt <= coverage.lastProbeAt &&
    !gapIntersects(e, coverage)
  );
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const n = values.length;
  return {
    n,
    mean: n ? values.reduce((sum, v) => sum + v, 0) / n : null,
    p50: n ? (values[Math.floor((n - 1) / 2)]! + values[Math.ceil((n - 1) / 2)]!) / 2 : null,
    p90: n ? values[Math.ceil(n * 0.9) - 1]! : null,
  };
}
function summarize(episodes: RecoveryEpisode[], now: number, coverage?: ObservationCoverage) {
  const complete = episodes.filter((e) => eligible(e, coverage));
  const recovered = complete.filter((e) => e.outcome === "recovered");
  const failed = complete.filter((e) => e.outcome === "failed");
  const closedKnown = recovered.length + failed.length;
  return {
    observed: episodes.length,
    partial: episodes.filter((e) => e.partial).length,
    censored: episodes.length - complete.length,
    active: episodes.filter((e) => e.outcome === "active").length,
    unknown: episodes.filter((e) => e.outcome === "unknown").length,
    recovered: recovered.length,
    failed: failed.length,
    closedKnown,
    successRate: closedKnown ? recovered.length / closedKnown : null,
    recoveredDurationMs: distribution(recovered.map((e) => e.closedAt! - e.startedAt)),
    recoveredAttempts: distribution(recovered.map((e) => e.attemptCount)),
    actions: {
      reload: episodes.reduce((n, e) => n + (e.actions?.reload ?? 0), 0),
      stop: episodes.reduce((n, e) => n + (e.actions?.stop ?? 0), 0),
      continue: episodes.reduce((n, e) => n + (e.actions?.continue ?? 0), 0),
    },
    observedAttempts: distribution(complete.map((e) => e.attemptCount)),
    activeAgeMs: distribution(
      complete.filter((e) => e.outcome === "active").map((e) => Math.max(0, now - e.startedAt)),
    ),
  };
}
/** Read-only, local to this browser profile/environment. No legacy event backfill: it cannot prove episodes. */
export function aggregateChatGPTRecoveryMetrics(environmentId: string, now = Date.now()) {
  const read = readChatGPTRecoveryMetrics(environmentId);
  const episodes = read.ledger?.episodes ?? [];
  const coverage = read.ledger?.observation;
  const observedEligible = episodes.filter((e) => eligible(e, coverage));
  return {
    availability: read.availability,
    observationStartedAt: read.ledger?.since ?? null,
    retainedStartedAt: episodes.length ? Math.min(...episodes.map((e) => e.startedAt)) : null,
    retainedUpdatedAt: episodes.length ? Math.max(...episodes.map((e) => e.updatedAt)) : null,
    dropped: read.ledger?.dropped ?? 0,
    droppedActive: read.ledger?.droppedActive ?? 0,
    observationCoverage: coverage ? ("probe-tracked" as const) : ("untracked" as const),
    unobservedPeriods: coverage
      ? {
          count: coverage.gapCount,
          elapsedMs: coverage.missedMs,
          firstProbeAt: coverage.firstProbeAt,
          lastProbeAt: coverage.lastProbeAt,
          retained: coverage.gaps.length,
          truncated: coverage.gapCount > coverage.gaps.length,
        }
      : null,
    censoredByGap: coverage ? episodes.filter((e) => gapIntersects(e, coverage)).length : null,
    eligibleEpisodes: observedEligible.length,
    ...summarize(episodes, now, coverage),
    byCategory: {
      red: summarize(
        episodes.filter((e) => e.category === "red"),
        now,
        coverage,
      ),
      orange: summarize(
        episodes.filter((e) => e.category === "orange"),
        now,
        coverage,
      ),
    },
    bySource: Object.fromEntries(
      (["automatic", "manual", "lost-route", "unspecified"] as const).map((source) => [
        source,
        summarize(
          episodes.filter((e) => (e.source ?? "unspecified") === source),
          now,
          coverage,
        ),
      ]),
    ),
    byCause: Object.fromEntries(
      (["load-failure", "interrupted", "stalled", "unknown"] as const).map((cause) => [
        cause,
        summarize(
          episodes.filter((e) => e.cause === cause),
          now,
          coverage,
        ),
      ]),
    ),
  };
}
