import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare, type LimitAccount } from "@t3tools/shared/usageLimits";

export type QuotaSample = { at: number; used: number };
export type QuotaHistory = Record<string, readonly QuotaSample[]>;

/**
 * Keep account and reset boundaries separate; never join two quota windows.
 * Reset times are rounded to the minute: the same window is reported with
 * sub-minute differences across probes and streamed events, and an exact match
 * would start a new one-sample series on every reading.
 */
export function quotaSeriesKey(account: LimitAccount, window: ServerProviderUsageWindow) {
  const resetMinute = Math.round(Date.parse(window.resetsAt!) / 60_000);
  return JSON.stringify([account.key, window.id, resetMinute, window.windowDurationMins]);
}

/** Banked reset credits per provider, Codex then Claude, summed across that provider's accounts. */
export function bankedResets(accounts: readonly LimitAccount[]) {
  return (["codex", "claudeAgent"] as const).map((driver) => {
    const credits = accounts
      .filter((account) => account.driver === driver)
      .flatMap((account) =>
        account.limits.resetCredits?.availableCount ? [account.limits.resetCredits] : [],
      );
    if (credits.length === 0) return null;
    const expiries = credits.flatMap((credit) =>
      credit.nextExpiresAt ? [credit.nextExpiresAt] : [],
    );
    return {
      availableCount: credits.reduce((sum, credit) => sum + credit.availableCount, 0),
      ...(expiries.length > 0
        ? { nextExpiresAt: expiries.toSorted((a, b) => Date.parse(a) - Date.parse(b))[0]! }
        : {}),
    };
  });
}

/** Merge series stored under exact (unrounded) reset-time keys into their rounded key. */
export function normalizeQuotaHistory(history: QuotaHistory): QuotaHistory {
  const merged: Record<string, QuotaSample[]> = {};
  for (const [key, samples] of Object.entries(history)) {
    let next = key;
    try {
      const parts = JSON.parse(key);
      if (Array.isArray(parts) && typeof parts[2] === "string") {
        next = JSON.stringify([
          parts[0],
          parts[1],
          Math.round(Date.parse(parts[2]) / 60_000),
          parts[3],
        ]);
      }
    } catch {
      /* Keep unrecognized keys as they are. */
    }
    (merged[next] ??= []).push(...samples);
  }
  return Object.fromEntries(
    Object.entries(merged).map(([key, samples]) => [
      key,
      samples
        .toSorted((a, b) => a.at - b.at)
        .filter((sample, index, sorted) => index === 0 || sample.at > sorted[index - 1]!.at),
    ]),
  );
}

export function quotaWindows(accounts: readonly LimitAccount[], now: number) {
  return (["weekly", "session"] as const).map((kind) => ({
    label: kind === "weekly" ? "week" : "5h",
    series: (["codex", "claudeAgent"] as const).map((driver) => {
      // With multiple subscriptions, show the most constrained account rather than
      // averaging away a nearly exhausted quota. The tooltip identifies the account.
      const candidates = accounts
        .filter((account) => account.driver === driver)
        .flatMap((account) =>
          account.limits.windows
            .filter(
              (window) =>
                window.kind === kind &&
                !(driver === "claudeAgent" && window.id.startsWith("seven_day_")) &&
                window.windowDurationMins === (kind === "weekly" ? 10080 : 300) &&
                window.resetsAt !== undefined &&
                Date.parse(window.resetsAt) > now &&
                elapsedShare(window, now) !== null,
            )
            .map((window) => ({ account, window, key: quotaSeriesKey(account, window) })),
        );
      return (
        candidates.sort(
          (a, b) => b.window.usedPercent - a.window.usedPercent || a.key.localeCompare(b.key),
        )[0] ?? null
      );
    }),
  }));
}

export function recordQuotaSamples(
  history: QuotaHistory,
  rows: ReturnType<typeof quotaWindows>,
  now: number,
): QuotaHistory {
  const next: QuotaHistory = Object.fromEntries(
    Object.entries(history)
      .filter(([, samples]) => (samples.at(-1)?.at ?? 0) >= now - 7 * 24 * 60 * 60_000)
      .sort((a, b) => (b[1].at(-1)?.at ?? 0) - (a[1].at(-1)?.at ?? 0))
      .slice(0, 32),
  );
  for (const row of rows)
    for (const series of row.series) {
      if (!series) continue;
      const { window, account, key } = series;
      const start = Date.parse(window.resetsAt!) - window.windowDurationMins! * 60_000;
      const at = Date.parse(account.limits.checkedAt);
      const samples = (history[key] ?? []).filter(
        (sample) => sample.at >= start && sample.at <= now,
      );
      // A repeated/stale snapshot must not imply that quota was measured again.
      if (
        Number.isFinite(at) &&
        at >= start &&
        at <= now &&
        (!samples.length || at > samples[samples.length - 1]!.at)
      ) {
        samples.push({ at, used: window.usedPercent });
      }
      // Bound storage while retaining the shape of the entire observed window.
      next[key] =
        samples.length > 256
          ? samples.filter((_, index) => index % 2 === 0 || index === samples.length - 1)
          : samples;
    }
  return next;
}

/** Null until readings reach back past the cutoff; a shorter history would understate the hour. */
export function quotaUsedInLastHour(samples: readonly QuotaSample[], now: number) {
  const cutoff = now - 60 * 60_000;
  const latest = samples.at(-1);
  if (!latest || latest.at <= cutoff) return null;
  let baseline: QuotaSample | undefined;
  for (const sample of samples) if (sample.at <= cutoff) baseline = sample;
  return baseline ? Math.max(0, latest.used - baseline.used) : null;
}

/** Estimate weekly quota consumption from paired observations within current reset windows. */
export function estimateWeeklyQuotaRisk(
  session: { key: string; window: ServerProviderUsageWindow },
  weekly: { key: string; window: ServerProviderUsageWindow },
  history: QuotaHistory,
  now: number,
) {
  const short = history[session.key] ?? [];
  const weeklyAt = new Map((history[weekly.key] ?? []).map((sample) => [sample.at, sample.used]));
  let shortGain = 0;
  let weeklyGain = 0;
  for (let i = 1; i < short.length; i++) {
    const before = short[i - 1]!;
    const after = short[i]!;
    const a = weeklyAt.get(before.at);
    const b = weeklyAt.get(after.at);
    if (a === undefined || b === undefined) continue;
    const ds = after.used - before.used;
    const dw = b - a;
    if (ds <= 0 || dw < 0) continue;
    shortGain += ds;
    weeklyGain += dw;
  }
  if (shortGain < 5 || weeklyGain < 0.5) return null;
  const weeklyPerSession = weeklyGain / shortGain;
  // Alert only when reaching 98% before the weekly reset is endangered.
  const remainingWeekly = Math.max(0, 98 - weekly.window.usedPercent);
  const equivalents = remainingWeekly / (100 * weeklyPerSession);
  const deadline = Date.parse(weekly.window.resetsAt ?? "");
  const sessionReset = Date.parse(session.window.resetsAt ?? "");
  if (!Number.isFinite(deadline) || deadline <= now ||
      !Number.isFinite(sessionReset) || sessionReset <= now) return null;
  const hoursLeft = (deadline - now) / 3_600_000;
  const nextResetHours = (sessionReset - now) / 3_600_000;
  // Optimistically assume a full 5h allowance takes 2h to consume. An almost
  // expired current window cannot contribute more than its remaining time permits.
  const currentCapacity = Math.min(
    Math.max(0, (100 - session.window.usedPercent) / 100), nextResetHours / 2,
  );
  const firstFraction = Math.min(equivalents, currentCapacity);
  const laterFraction = Math.max(0, equivalents - firstFraction);
  const freshWindows = Math.ceil(laterFraction);
  const totalWindows = (firstFraction > 0 ? 1 : 0) + freshWindows;
  const minimumActiveHours = equivalents * 2;
  const minimumElapsedHours = freshWindows > 0
    ? Math.max(firstFraction * 2, nextResetHours) +
      (freshWindows - 1) * 5 + (laterFraction - (freshWindows - 1)) * 2
    : firstFraction * 2;
  // The 01:00–13:00 sleep window is approximate; reserve 8h/day for sleep.
  const awakeHours = hoursLeft * (16 / 24);
  return {
    weeklyPerSession, sampleSessionGain: shortGain, sampleWeeklyGain: weeklyGain,
    equivalents, totalWindows, hoursLeft, awakeHours,
    minimumActiveHours, minimumElapsedHours,
    // Warn with a 20% margin for variable conversion and sleep timing.
    atRisk: remainingWeekly > 0 &&
      (minimumActiveHours > awakeHours * 0.8 || minimumElapsedHours > hoursLeft * 0.8),
  };
}

export function quotaPath(samples: readonly QuotaSample[], window: ServerProviderUsageWindow) {
  return samples
    .map((sample, index) => {
      const x = 5 + 270 * (elapsedShare(window, sample.at) ?? 0);
      const y = 65 - sample.used * 0.6;
      return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}
