// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Local bounded audit trail for automatic T3 capacity decisions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const COOLDOWN_MS = 90_000;
const MAX_LOG_BYTES = 2_000_000;

type Capacity = {
  limit: number; used: number; reserved: number; workingIds: string[];
  unknown: number; reason: string | null;
};

type Decision = {
  ticket: string;
  target?: string;
  decision: "admitted" | "deferred";
  reason: string;
  capacity: Capacity | null;
  alreadyHeld: boolean;
};

export class AutomaticAdmissionJournal {
  private readonly file: string;
  private cooldownUntil = 0;
  private lastDeferred: string | null = null;
  private lastDeferredAt = 0;

  constructor(stateDir: string) {
    this.file = NodePath.join(stateDir, "autowork-admissions.ndjson");
    // A T3 restart must not discard the brief cooldown after a recent launch.
    try {
      const recent = NodeFS.readFileSync(this.file, "utf8").trim().split("\n").slice(-500);
      for (const line of recent) {
        try {
          const entry = JSON.parse(line) as { cooldownUntil?: number };
          if (Number.isFinite(entry.cooldownUntil))
            this.cooldownUntil = Math.max(this.cooldownUntil, entry.cooldownUntil!);
        } catch { /* Ignore a torn trailing line; earlier receipts are still valid. */ }
      }
    } catch { /* No previous admission history. */ }
  }

  get delayMs() { return Math.max(0, this.cooldownUntil - Date.now()); }

  record(input: Decision) {
    const now = Date.now();
    const key = JSON.stringify([
      input.ticket, input.decision, input.reason, input.capacity?.used,
      input.capacity?.reserved, input.capacity?.unknown,
    ]);
    if (input.decision === "deferred" && this.lastDeferred === key &&
        now - this.lastDeferredAt < 30_000) return;
    if (input.decision === "deferred") {
      this.lastDeferred = key;
      this.lastDeferredAt = now;
    }
    if (input.decision === "admitted")
      this.cooldownUntil = Math.max(this.cooldownUntil, now + COOLDOWN_MS);
    this.append({
      at: new Date(now).toISOString(), event: "decision", ...input,
      cooldownUntil: this.cooldownUntil,
    });
  }

  released(ticket: string) {
    const now = Date.now();
    this.cooldownUntil = Math.max(this.cooldownUntil, now + COOLDOWN_MS);
    this.append({
      at: new Date(now).toISOString(), event: "released", ticket,
      cooldownUntil: this.cooldownUntil,
    });
  }

  private append(row: Record<string, unknown>) {
    try {
      if (NodeFS.existsSync(this.file) && NodeFS.statSync(this.file).size >= MAX_LOG_BYTES) {
        NodeFS.rmSync(this.file + ".1", { force: true });
        NodeFS.renameSync(this.file, this.file + ".1");
      }
      NodeFS.appendFileSync(this.file, JSON.stringify(row) + "\n", "utf8");
    } catch { /* Diagnostic I/O must not break task admission. */ }
  }
}
