import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import {
  bankedResets,
  estimateWeeklyQuotaRisk,
  normalizeQuotaHistory,
  quotaPath,
  quotaUsedInLastHour,
  quotaWindows,
  recordQuotaSamples,
} from "./quotaPacing";

const now = Date.parse("2026-10-08T12:00:00Z");
const window: ServerProviderUsageWindow = {
  id: "primary",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-10-08T14:00:00Z",
};
function account(key: string, windows = [window]): LimitAccount {
  return {
    key,
    driver: ProviderDriverKind.make("codex"),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: new Date(now).toISOString(), windows },
  };
}

describe("quota pacing", () => {
  it("forecasts quota from timestamp-paired readings and rejects sparse data", () => {
    const session = { key: "five", window: { ...window, usedPercent: 50 } };
    const weekly = { key: "week", window: {
      ...window, kind: "weekly" as const, usedPercent: 80,
      resetsAt: new Date(now + 18 * 3_600_000).toISOString(),
      windowDurationMins: 10080,
    } };
    const readings = {
      five: [{ at: now - 60_000, used: 25 }, { at: now, used: 50 }],
      week: [{ at: now - 60_000, used: 77.5 }, { at: now, used: 80 }],
    };
    const result = estimateWeeklyQuotaRisk(session, weekly, readings, now)!;
    expect(result.weeklyPerSession).toBeCloseTo(0.1);
    expect(result.equivalents).toBeCloseTo(1.8);
    expect(result.totalWindows).toBe(3);
    expect(result.minimumElapsedHours).toBeGreaterThan(result.minimumActiveHours);
    expect(estimateWeeklyQuotaRisk(session, weekly, { ...readings, week: [readings.week[1]!] }, now)).toBeNull();
  });
  it("shows the most constrained real account without averaging subscriptions", () => {
    const rows = quotaWindows([account("a"), account("b", [{ ...window, usedPercent: 80 }])], now);
    expect(rows[1]!.series[0]!.account.key).toBe("b");
    expect(rows[1]!.series[1]).toBeNull();
  });
  it("excludes expired, unknown and differently sized windows from the 5h strip", () => {
    const rows = quotaWindows(
      [
        account("a", [
          { ...window, resetsAt: undefined },
          { ...window, resetsAt: new Date(now).toISOString() },
          { ...window, windowDurationMins: 60 },
        ]),
      ],
      now,
    );
    expect(rows[1]!.series).toEqual([null, null]);
  });
  it("uses Claude's overall weekly allowance rather than a model-specific bucket", () => {
    const claude = {
      ...account("claude", [
        { ...window, id: "seven_day", kind: "weekly", windowDurationMins: 10080 },
        {
          ...window,
          id: "seven_day_opus",
          kind: "weekly",
          windowDurationMins: 10080,
          usedPercent: 90,
        },
      ]),
      driver: ProviderDriverKind.make("claudeAgent"),
    };
    expect(quotaWindows([claude], now)[0]!.series[1]!.window.id).toBe("seven_day");
  });
  it("records observed readings only, deduplicates snapshots, and isolates resets", () => {
    const rows = quotaWindows([account("a")], now);
    const key = rows[1]!.series[0]!.key;
    const history = recordQuotaSamples({}, rows, now);
    expect(history[key]).toEqual([{ at: now, used: 40 }]);
    expect(recordQuotaSamples(history, rows, now + 60_000)).toEqual(history);
    const nextAccount = account("a", [
      { ...window, resetsAt: "2026-10-08T17:00:00Z", usedPercent: 0 },
    ]);
    const nextRows = quotaWindows([nextAccount], now);
    const nextKey = nextRows[1]!.series[0]!.key;
    expect(nextKey).not.toBe(key);
    expect(recordQuotaSamples(history, nextRows, now)[nextKey]).toEqual([{ at: now, used: 0 }]);
    expect(recordQuotaSamples(history, quotaWindows([], now), now)).toEqual(history);
  });
  it("keeps one series when the same window's reset time drifts by seconds", () => {
    const first = recordQuotaSamples({}, quotaWindows([account("a")], now), now);
    const drifted = {
      ...account("a", [{ ...window, resetsAt: "2026-10-08T14:00:20.500Z" }]),
      limits: {
        checkedAt: new Date(now + 60_000).toISOString(),
        windows: [{ ...window, resetsAt: "2026-10-08T14:00:20.500Z" }],
      },
    };
    const later = recordQuotaSamples(first, quotaWindows([drifted], now + 60_000), now + 60_000);
    const key = quotaWindows([drifted], now)[1]!.series[0]!.key;
    expect(later[key]).toEqual([
      { at: now, used: 40 },
      { at: now + 60_000, used: 40 },
    ]);
  });
  it("merges history stored under jittered exact reset times into one series", () => {
    const stored = {
      '["a","five_hour","2026-10-08T15:19:59.518Z",300]': [{ at: now, used: 1 }],
      '["a","five_hour","2026-10-08T15:20:00.261Z",300]': [
        { at: now, used: 1 },
        { at: now + 1000, used: 5 },
      ],
    };
    expect(normalizeQuotaHistory(stored)).toEqual({
      [JSON.stringify(["a", "five_hour", Date.parse("2026-10-08T15:20:00Z") / 60_000, 300])]: [
        { at: now, used: 1 },
        { at: now + 1000, used: 5 },
      ],
    });
  });
  it("places each provider's observations relative to its own reset time", () => {
    expect(quotaPath([{ at: now, used: 40 }], window)).toBe("M167.00 41.00");
    expect(
      quotaPath([{ at: now, used: 40 }], { ...window, resetsAt: "2026-10-08T16:00:00Z" }),
    ).toBe("M59.00 41.00");
  });
  it("measures the last hour from the latest reading at or before one hour ago", () => {
    const hour = 60 * 60_000;
    const samples = [
      { at: now - 2 * hour, used: 10 },
      { at: now - hour - 1000, used: 11 },
      { at: now - hour + 1000, used: 12 },
      { at: now, used: 12.5 },
    ];
    expect(quotaUsedInLastHour(samples, now)).toBeCloseTo(1.5);
  });
  it("reports no last-hour usage when history does not reach back an hour", () => {
    expect(quotaUsedInLastHour([{ at: now - 30 * 60_000, used: 3 }], now)).toBeNull();
    expect(quotaUsedInLastHour([{ at: now - 2 * 60 * 60_000, used: 3 }], now)).toBeNull();
    expect(quotaUsedInLastHour([], now)).toBeNull();
  });
  it("bounds samples while preserving first and latest observations", () => {
    const rows = quotaWindows([account("a")], now);
    const key = rows[1]!.series[0]!.key;
    const samples = Array.from({ length: 256 }, (_, i) => ({
      at: now - 256_000 + i * 1000,
      used: i / 10,
    }));
    const next = recordQuotaSamples({ [key]: samples }, rows, now)[key]!;
    expect(next.length).toBeLessThanOrEqual(256);
    expect(next[0]).toEqual(samples[0]);
    expect(next.at(-1)).toEqual({ at: now, used: 40 });
  });
  it("sums banked resets per provider and keeps the soonest expiry", () => {
    const banked = (key: string, availableCount: number, nextExpiresAt?: string) => ({
      ...account(key),
      limits: {
        ...account(key).limits,
        resetCredits: { availableCount, ...(nextExpiresAt ? { nextExpiresAt } : {}) },
      },
    });
    expect(
      bankedResets([
        banked("a", 1, "2026-11-01T00:00:00Z"),
        banked("b", 2, "2026-10-20T00:00:00Z"),
        banked("c", 0),
      ]),
    ).toEqual([{ availableCount: 3, nextExpiresAt: "2026-10-20T00:00:00Z" }, null]);
    expect(bankedResets([banked("a", 0)])).toEqual([null, null]);
  });
});
