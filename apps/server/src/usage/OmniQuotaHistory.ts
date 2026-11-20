// @effect-diagnostics-next-line nodeBuiltinImport:off - Atomic snapshot persistence is an intentionally isolated Node filesystem operation.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Matches the atomic Node filesystem snapshot helper above.
import { join } from "node:path";

export interface DesktopQuotaSample {
  readonly at: number;
  readonly used: number;
}
export interface DesktopQuotaSeries {
  readonly driver: "codex" | "claudeAgent";
  readonly accountName: string;
  readonly accountKey: string;
  readonly checkedAt: string;
  readonly window: {
    readonly id: string;
    readonly kind: "session" | "weekly";
    readonly windowDurationMins: number;
    readonly usedPercent: number;
    readonly resetsAt: string;
  };
  readonly samples: readonly DesktopQuotaSample[];
}
export interface DesktopQuotaSnapshot {
  readonly capturedAt: number;
  readonly series: readonly DesktopQuotaSeries[];
}
const filename = "quota-pacing-desktop.json";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPercent = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
const isTimestamp = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const isDate = (s: unknown): s is string =>
  typeof s === "string" && s.length < 80 && Number.isFinite(Date.parse(s));
const isName = (s: unknown): s is string => typeof s === "string" && s.length <= 160;

/** The desktop renderer sends only selected quota curves and bounded historical samples. */
export function isDesktopQuotaSnapshot(value: unknown): value is DesktopQuotaSnapshot {
  if (!isObject(value) || !isTimestamp(value.capturedAt) ||
      !Array.isArray(value.series) || value.series.length > 6) return false;
  return value.series.every((item: unknown) => {
    if (!isObject(item) || (item.driver !== "codex" && item.driver !== "claudeAgent") ||
        !isName(item.accountName) || !isName(item.accountKey) || !isDate(item.checkedAt) ||
        !Array.isArray(item.samples) || item.samples.length > 256 ||
        !isObject(item.window)) return false;
    const w = item.window;
    if (!isName(w.id) || (w.kind !== "session" && w.kind !== "weekly") ||
        (w.windowDurationMins !== 300 && w.windowDurationMins !== 10080) ||
        !isPercent(w.usedPercent) || !isDate(w.resetsAt)) return false;
    let previous = 0;
    return item.samples.every((point: unknown) => {
      if (!isObject(point) || !isTimestamp(point.at) || !isPercent(point.used) ||
          point.at <= previous) return false;
      previous = point.at;
      return true;
    });
  });
}
export async function readDesktopQuotaSnapshot(stateDir: string): Promise<DesktopQuotaSnapshot | null> {
  try {
    const json: unknown = JSON.parse(await readFile(join(stateDir, filename), "utf8"));
    return isDesktopQuotaSnapshot(json) ? json : null;
  } catch {
    return null;
  }
}
export async function writeDesktopQuotaSnapshot(stateDir: string, snapshot: DesktopQuotaSnapshot) {
  await mkdir(stateDir, { recursive: true });
  const target = join(stateDir, filename);
  // @effect-diagnostics-next-line globalDate:off - Temp-file disambiguator, not a domain timestamp.
  const temp = target + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temp, JSON.stringify(snapshot), { encoding: "utf8" });
  await rename(temp, target);
}
