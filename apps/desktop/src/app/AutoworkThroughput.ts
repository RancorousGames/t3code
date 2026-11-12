// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Local desktop activity journal.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const HOUR = 3_600_000;
const RETENTION = 8 * 24 * HOUR;
const OBSERVATION_GAP = 90_000;
type Interval = { start: number; end: number };
type Start = { key: string; at: number };
type Completion = { key: string; at: number };
interface Journal {
  version: 1;
  intervals: Interval[];
  sessions: Start[];
  completions: Completion[];
}
export interface HourlyAutoworkBucket {
  at: number;
  activeMs: number;
  completed: number;
  sessions: number;
}

/** Local, durable instrumentation; an OFF period is not silently counted as zero productivity. */
export class AutoworkThroughput {
  private readonly file: string;
  private intervals: Interval[] = [];
  private sessions: Start[] = [];
  private completions: Completion[] = [];
  private enabled = false;
  private lastWrite = 0;
  private writable = true;

  constructor(stateDir: string, enabled: boolean) {
    this.file = NodePath.join(stateDir, "autowork-throughput-v1.json");
    try {
      const saved = JSON.parse(NodeFS.readFileSync(this.file, "utf8")) as Journal;
      if (saved.version !== 1 || !Array.isArray(saved.intervals) ||
          !Array.isArray(saved.sessions) || !Array.isArray(saved.completions))
        throw Error("Unsupported throughput journal");
      this.intervals = saved.intervals.filter(row =>
        Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start);
      this.sessions = saved.sessions.filter(row =>
        typeof row.key === "string" && Number.isFinite(row.at));
      this.completions = saved.completions.filter(row =>
        typeof row.key === "string" && Number.isFinite(row.at));
    } catch {
      // Do not overwrite a corrupted history with an apparently empty one.
      if (NodeFS.existsSync(this.file)) this.writable = false;
    }
    this.prune(Date.now());
    this.setEnabled(enabled);
  }

  private prune(now: number) {
    const cutoff = now - RETENTION;
    this.intervals = this.intervals.filter(row => row.end >= cutoff);
    this.sessions = this.sessions.filter(row => row.at >= cutoff);
    this.completions = this.completions.filter(row => row.at >= cutoff);
  }

  private save(now = Date.now()) {
    if (!this.writable) return;
    this.prune(now);
    const tmp = this.file + "." + process.pid + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify({
        version: 1, intervals: this.intervals,
        sessions: this.sessions, completions: this.completions,
      } satisfies Journal), { encoding: "utf8" });
      NodeFS.renameSync(tmp, this.file);
      this.lastWrite = now;
    } catch {
      // Keep the in-memory data even if a filesystem or sync drive is unavailable.
    } finally {
      try { if (NodeFS.existsSync(tmp)) NodeFS.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  setEnabled(enabled: boolean, now = Date.now()) {
    if (this.enabled === enabled) {
      this.heartbeat(now);
      return;
    }
    if (this.enabled) {
      const last = this.intervals[this.intervals.length - 1];
      if (last) last.end = Math.max(last.start,
        Math.min(now, last.end + OBSERVATION_GAP));
    }
    this.enabled = enabled;
    if (enabled) this.intervals.push({ start: now, end: now });
    this.save(now);
  }

  heartbeat(now = Date.now()) {
    if (!this.enabled) return;
    const last = this.intervals[this.intervals.length - 1];
    if (!last) return;
    if (now - last.end > OBSERVATION_GAP) {
      // A suspended/crashed desktop must not turn an unobserved gap into active time.
      this.intervals.push({ start: now, end: now });
    } else {
      last.end = Math.max(last.end, now);
    }
    if (now - this.lastWrite >= 30_000) this.save(now);
  }

  private activeAt(at: number): boolean {
    return this.intervals.some(row =>
      row.start <= at && at <= (this.enabled && row === this.intervals[this.intervals.length - 1]
        ? Math.min(Date.now(), row.end + OBSERVATION_GAP) : row.end));
  }

  /** Called only after a concrete auto-created session receipt, never for a retry/UNKNOWN. */
  recordSession(key: string, at = Date.now()) {
    if (!this.enabled || !this.writable || this.sessions.some(row => row.key === key)) return;
    this.heartbeat(at);
    this.sessions.push({ key, at });
    this.save(at);
  }

  /** TaskBoard completion timestamps, not polling time, decide which policy interval owns it. */
  recordCompletion(key: string, at: number) {
    if (!this.writable || !Number.isFinite(at) || at > Date.now() + 5_000 ||
        !this.activeAt(at) || this.completions.some(row => row.key === key)) return;
    this.completions.push({ key, at });
    this.save();
  }

  snapshot(now = Date.now()) {
    this.heartbeat(now);
    const buckets = (count: number): HourlyAutoworkBucket[] => {
      const start = now - count * HOUR;
      return Array.from({ length: count }, (_, i) => {
        const at = start + i * HOUR;
        const stop = at + HOUR;
        const activeMs = this.intervals.reduce((sum, row) =>
          sum + Math.max(0, Math.min(stop, row.end) - Math.max(at, row.start)), 0);
        return {
          at, activeMs,
          completed: this.completions.filter(row => row.at >= at && row.at < stop).length,
          sessions: this.sessions.filter(row => row.at >= at && row.at < stop).length,
        };
      });
    };
    return {
      trackingSince: this.intervals[0]?.start ?? null,
      busyNow: this.enabled,
      available: this.writable,
      day: buckets(24),
      week: buckets(168),
    };
  }
}
