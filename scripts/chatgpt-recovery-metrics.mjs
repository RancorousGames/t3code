/** Allowlists numeric recovery aggregates at the local CLI boundary.
 * Unexpected payloads are rejected, never forwarded as transcript-shaped data. */
export function sanitizeRecoveryAggregate(raw) {
  const object = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid recovery telemetry payload.");
    return value;
  };
  const number = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid recovery telemetry number.");
    return value;
  };
  const nullableNumber = (value) => (value === null ? null : number(value));
  const distribution = (value) => {
    const v = object(value);
    return {
      n: number(v.n),
      mean: nullableNumber(v.mean),
      p50: nullableNumber(v.p50),
      p90: nullableNumber(v.p90),
    };
  };
  const summary = (value) => {
    const v = object(value);
    const actions = object(v.actions);
    return {
      observed: number(v.observed),
      partial: number(v.partial),
      censored: number(v.censored),
      active: number(v.active),
      unknown: number(v.unknown),
      recovered: number(v.recovered),
      failed: number(v.failed),
      closedKnown: number(v.closedKnown),
      successRate: nullableNumber(v.successRate),
      recoveredDurationMs: distribution(v.recoveredDurationMs),
      recoveredAttempts: distribution(v.recoveredAttempts),
      actions: {
        reload: number(actions.reload),
        stop: number(actions.stop),
        continue: number(actions.continue),
      },
      observedAttempts: distribution(v.observedAttempts),
      activeAgeMs: distribution(v.activeAgeMs),
    };
  };
  const group = (value, names) => {
    const v = object(value);
    return Object.fromEntries(names.map((name) => [name, summary(v[name])]));
  };
  const v = object(raw);
  if (
    !["available", "missing", "unavailable"].includes(v.availability) ||
    !["probe-tracked", "untracked"].includes(v.observationCoverage)
  )
    throw new Error("Desktop has not confirmed the supported recovery telemetry schema.");
  const unobserved =
    v.unobservedPeriods === null
      ? null
      : (() => {
          const p = object(v.unobservedPeriods);
          return {
            count: number(p.count),
            elapsedMs: number(p.elapsedMs),
            firstProbeAt: number(p.firstProbeAt),
            lastProbeAt: number(p.lastProbeAt),
            retained: number(p.retained),
            truncated: p.truncated === true,
          };
        })();
  return {
    availability: v.availability,
    observationStartedAt: nullableNumber(v.observationStartedAt),
    retainedStartedAt: nullableNumber(v.retainedStartedAt),
    retainedUpdatedAt: nullableNumber(v.retainedUpdatedAt),
    dropped: number(v.dropped),
    droppedActive: number(v.droppedActive),
    observationCoverage: v.observationCoverage,
    unobservedPeriods: unobserved,
    censoredByGap: nullableNumber(v.censoredByGap),
    eligibleEpisodes: number(v.eligibleEpisodes),
    ...summary(v),
    byCategory: group(v.byCategory, ["red", "orange"]),
    byCause: group(v.byCause, ["load-failure", "interrupted", "stalled", "unknown"]),
    bySource: group(v.bySource, ["automatic", "manual", "lost-route", "unspecified"]),
  };
}
