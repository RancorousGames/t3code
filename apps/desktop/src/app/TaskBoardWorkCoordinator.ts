// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- T3 owns the dispatcher clock; TaskBoard owns reservations.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCP from "node:child_process";
import type { CaffyScheduler } from "./CaffyScheduler.ts";

type ProjectPriority = "high" | "normal" | "low";
interface Project { id: string; name: string; path: string; dispatchEnabled: boolean; priority?: ProjectPriority }
interface Catalog { schema: 1; projects: Project[]; hiddenPaths?: string[] }
type QueueState = "queued" | "reserved" | "starting" | "working" | "completed";
interface QueueItem {
  taskId: string;
  title: string;
  created: string;
  priority: "urgent" | "routine";
  dependencies: string[];
  readiness: boolean;
  readinessReason?: string | null;
  claimed: boolean;
  claimedBy?: string | null;
  queueRequest: string;
  state: QueueState;
  reservationId?: string | null;
  reservationExpiresAt?: string | null;
  sessionId?: string | null;
  legacyOpenRig: boolean;
  error?: string | null;
}
interface QueueSnapshot {
  boardRoot: string; projectName: string; projectId: string;
  items: QueueItem[]; dispatchEnabled: boolean; projectPriority: ProjectPriority;
}
interface QueueCandidate {
  boardRoot: string; projectPriority: ProjectPriority;
  item: Pick<QueueItem, "taskId" | "created" | "priority">;
}

/** Priority is global. Balancing and board preference apply only within a priority tier. */
export function compareQueuedCandidates(
  a: QueueCandidate, b: QueueCandidate, boardLoad: ReadonlyMap<string, number>, now: number,
): number {
  const urgency = (a.item.priority === "urgent" ? 0 : 1) - (b.item.priority === "urgent" ? 0 : 1);
  const load = (boardLoad.get(rootKey(a.boardRoot)) ?? 0) - (boardLoad.get(rootKey(b.boardRoot)) ?? 0);
  const rank = (priority: ProjectPriority) => priority === "high" ? 0 : priority === "low" ? 2 : 1;
  const projectPriority = rank(a.projectPriority) - rank(b.projectPriority);
  const isRecent = (created: string) => {
    // TaskBoard legacy creation is a local date, not a timestamp. Treat its
    // entire calendar day as potentially within the last 24h.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(created);
    const [year, month, day] = dateOnly ? created.split("-").map(Number) : [];
    const time = dateOnly ? new Date(year!, month! - 1, day!).getTime() : Date.parse(created);
    const end = dateOnly ? new Date(year!, month! - 1, day! + 1).getTime() : time;
    return Number.isFinite(time) && time <= now && end >= now - 24 * 60 * 60_000;
  };
  const recent = Number(isRecent(b.item.created)) - Number(isRecent(a.item.created));
  const number = (id: string) => Number(id.match(/-(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return urgency || load || projectPriority || recent ||
    number(a.item.taskId) - number(b.item.taskId) ||
    a.boardRoot.localeCompare(b.boardRoot) || a.item.taskId.localeCompare(b.item.taskId);
}
/** A prior session for the same task must not hold a newer Starting request. */
export function sessionsForStartRequest<T extends {spawnRequestId?: string}>(
  sessions: ReadonlyArray<T>, requestId: string,
): T[] {
  return sessions.filter(session => session.spawnRequestId === requestId);
}

interface SessionBoardIdentity {
  id: string; project?: string | null;
  binding?: {taskRef?: {board?: string}};
}

/** Exact task board wins; a session's project label is usable only if unambiguous. */
export function boardOwnersFromSessions(
  boards: ReadonlyArray<Pick<QueueSnapshot, "boardRoot" | "projectName" | "projectId">>,
  sessions: ReadonlyArray<SessionBoardIdentity>,
): Map<string, string> {
  const byName = new Map<string, string | null>();
  for (const board of boards) {
    for (const name of [board.projectName, board.projectId]) {
      const key = name.trim().toLowerCase();
      const root = rootKey(board.boardRoot);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, root);
      else if (byName.get(key) !== root) byName.set(key, null);
    }
  }
  const roots = new Set(boards.map(board => rootKey(board.boardRoot)));
  const owners = new Map<string, string>();
  for (const session of sessions) {
    const bound = session.binding?.taskRef?.board;
    const taskRoot = bound && NodePath.isAbsolute(bound) ? rootKey(bound) : null;
    const projectRoot = byName.get(session.project?.trim().toLowerCase() ?? "") ?? null;
    const root = taskRoot && roots.has(taskRoot) ? taskRoot : projectRoot;
    if (root) owners.set(session.id, root);
  }
  return owners;
}

interface RetiredGuestReceipt {
  boardRoot: string; taskId: string; queueRequest: string;
  requestId: string; sessionId: string;
}
interface ManagedWorkerWake {
  boardRoot: string; taskId: string; requestId: string;
  sessionId: string; conversationId: string;
  beginAt: number; lastAttemptAt: number; active: boolean;
}
const ROOT_CANDIDATES = [
  process.env.T3CODE_REPO_ROOT,
  NodePath.resolve(import.meta.dirname, "..", "..", "..", ".."),
  process.cwd(),
  NodePath.resolve(process.cwd(), ".."),
  NodePath.resolve(process.cwd(), "..", ".."),
  "D:\\SSDProjects\\Tools\\t3code",
].filter((value): value is string => !!value).map(value => NodePath.resolve(value));
function resolveRoot(): string {
  const root = ROOT_CANDIDATES.find(value =>
    NodeFS.existsSync(NodePath.join(value, "scripts", "taskboard-dispatch.mjs")));
  if (!root) throw new Error("T3 TaskBoard dispatcher scripts could not be located.");
  return root;
}
const ROOT = resolveRoot();
const TASKBOARD_CLI = process.env.TASKBOARD_CLI
  ? NodePath.resolve(process.env.TASKBOARD_CLI)
  : NodePath.resolve(ROOT, "..", "TaskBoard", "packages", "task-cli", "target", "release", "taskboard.exe");
const TASKBOARD_CATALOG = () => NodePath.join(
  process.env.APPDATA ?? NodePath.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "TaskBoard", "projects.json",
);
const RESERVATION_LEASE_SECONDS = 180;
const STARTING_HOLD_MS = 5 * 60_000;
const STARTING_RECHECK_MS = 45_000;
// A guest stuck at the original prompt must not monopolize a queue item for hours.
const UNSTARTED_GUEST_GRACE_MS = 2 * 60_000;
const PUMP_INTERVAL_MS = 20_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const PUMP_STUCK_MS = 4 * 60_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function cli(command: string, args: string[], stdin?: string, timeout = 35_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = NodeCP.spawn(command, args, {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", completed = false;
    const timer = setTimeout(() => {
      if (completed) return;
      child.kill();
      reject(new Error("TaskBoard/T3 command timeout; outcome is unknown and the same reservation must be reconciled."));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
      if (stdout.length > 16_000_000) child.kill();
    });
    child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-3000); });
    child.on("error", error => {
      if (completed) return;
      completed = true; clearTimeout(timer); reject(error);
    });
    child.on("close", code => {
      if (completed) return;
      completed = true; clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command exited ${String(code)}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as unknown); }
      catch { reject(new Error("Command receipt unreadable; preserve the current reservation and reconcile.")); }
    });
    child.stdin.end(stdin);
  });
}

function rootKey(value: string) { return NodePath.resolve(value).toLowerCase(); }

/** Durable queue identity survives worker-session closure and TaskBoard cleanup. */
export function completedQueueTask(
  item: Pick<QueueItem, "state" | "queueRequest" | "legacyOpenRig">,
  frontmatter: string,
): { at: number; stamp: string } | null {
  if (item.state !== "completed" || item.legacyOpenRig) return null;
  const field = (name: string) =>
    new RegExp(`^\\s*${name}:\\s*(.*?)\\s*$`, "m").exec(frontmatter)?.[1];
  if (field("column") !== "done" || field("execution_mode") !== "queue" ||
      !item.queueRequest || field("queue_request") !== item.queueRequest) return null;
  const stamp = field("completed_at") ?? "";
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? { at, stamp } : null;
}

export class TaskBoardWorkCoordinator {
  private readonly caffy: CaffyScheduler;
  private readonly home: string;
  private readonly retiredGuestDir: string;
  private lastUnstartedGuestCheckAt = 0;
  private readonly rejectedUnstartedGuests = new Map<string, number>();
  private lastAbandonedStartCheckAt = 0;
  private lastReleasedWorkerCheckAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private followupTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private lastError: string | null = null;
  private lastObservedAt: string | null = null;
  private lastCompletionScanAt = 0;
  private readonly completionMtimes = new Map<string, number>();
  private snapshots: QueueSnapshot[] = [];
  private sessionBoardOwners = new Map<string, string>();
  private lastSessionOwnerScanAt = 0;
  private lastPromptRecoveryAt = 0;
  private readonly promptRecoveryAttempts = new Map<string, number>();
  private readonly startingFirstSeen = new Map<string, number>();
  private readonly admittedStarts = new Map<string, number>();
  private readonly startingLastAttempt = new Map<string, number>();
  // A definite rejection is safe to retry, but it must not monopolize the
  // first Queue position. Unknown/possibly-created spawns are NEVER retried.
  private readonly definiteFailures = new Map<string, {
    attempts: number; retryAt: number; reason: string;
  }>();
  private lastAdmissionAt: number | null = null;
  private lastAdmissionAttemptAt: number | null = null;
  private lastIdleReason: string | null = null;
  private pumpStartedAt: number | null = null;
  private lastPumpCompletedAt: number | null = null;
  private readonly workerWakeJournal: string;
  private readonly managedWorkerWakes = new Map<string, ManagedWorkerWake>();
  private lastWorkerWakeScanAt = 0;
  private workerWakeScanRunning = false;
  private workerWakeJournalReady = true;

  private retryKey(boardRoot: string, item: QueueItem): string {
    return rootKey(boardRoot) + "\0" + item.taskId + "\0" + item.queueRequest;
  }

  private backoffDefiniteFailure(boardRoot: string, item: QueueItem, reason: string) {
    const key = this.retryKey(boardRoot, item);
    const attempts = (this.definiteFailures.get(key)?.attempts ?? 0) + 1;
    const retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5));
    this.definiteFailures.set(key, { attempts, retryAt, reason });
    this.lastIdleReason = `Task ${item.taskId} rejected before creation; retry after ${new Date(retryAt).toLocaleTimeString()} while checking other queued tasks.`;
  }

  constructor(stateDir: string, caffy: CaffyScheduler) {
    this.caffy = caffy;
    // The desktop state directory is <T3 home>/userdata (or /dev in a
    // source-checkout run). Standalone CLI requests must use the same pipe.
    this.home = NodePath.resolve(stateDir, "..");
    this.retiredGuestDir = NodePath.join(stateDir, "task-retired-guests");
    this.workerWakeJournal = NodePath.join(stateDir, "taskboard-managed-worker-wakes.json");
    try {
      const saved = JSON.parse(NodeFS.readFileSync(this.workerWakeJournal, "utf8")) as {
        version?: number; rows?: ManagedWorkerWake[];
      };
      if (saved.version !== 1 || !Array.isArray(saved.rows)) throw Error("Unsupported worker wake journal");
      for (const row of saved.rows) {
        if (UUID.test(row.sessionId) && UUID.test(row.conversationId) &&
            UUID.test(row.requestId) && Number.isFinite(row.beginAt) &&
            typeof row.boardRoot === "string" && typeof row.taskId === "string")
          this.managedWorkerWakes.set(row.sessionId, row);
      }
    } catch (error) {
      if (NodeFS.existsSync(this.workerWakeJournal)) {
        // An unreadable ownership journal must never be overwritten; without
        // it we cannot distinguish auto Caffy from a user's manual monitor.
        this.workerWakeJournalReady = false;
        this.lastError = `Task worker wake journal needs inspection: ${String(error)}`;
      }
    }
  }

  private saveWorkerWakes() {
    if (!this.workerWakeJournalReady) return;
    const temporary = this.workerWakeJournal + ".tmp";
    try {
      NodeFS.writeFileSync(temporary, JSON.stringify({
        version: 1, rows: [...this.managedWorkerWakes.values()],
      }), { encoding: "utf8", flush: true });
      NodeFS.renameSync(temporary, this.workerWakeJournal);
    } finally {
      if (NodeFS.existsSync(temporary)) NodeFS.rmSync(temporary, { force: true });
    }
  }

  private projects(): Project[] {
    let catalog: Catalog;
    try { catalog = JSON.parse(NodeFS.readFileSync(TASKBOARD_CATALOG(), "utf8")) as Catalog; }
    catch (error) { throw new Error(`TaskBoard project catalog unavailable: ${String(error)}`); }
    if (catalog.schema !== 1 || !Array.isArray(catalog.projects) ||
        (catalog.hiddenPaths !== undefined &&
          (!Array.isArray(catalog.hiddenPaths) || catalog.hiddenPaths.some(path => typeof path !== "string"))))
      throw new Error("TaskBoard project catalog has an unsupported schema.");
    const hidden = new Set((catalog.hiddenPaths ?? []).map(rootKey));
    const seen = new Set<string>();
    const projects: Project[] = [];
    for (const project of catalog.projects) {
      if (!project || typeof project.path !== "string" || !NodePath.isAbsolute(project.path))
        throw new Error("TaskBoard project catalog contains an invalid board path.");
      const key = rootKey(project.path);
      if (seen.has(key)) continue;
      if (!NodeFS.existsSync(NodePath.join(project.path, "_board.md")))
        throw new Error(`TaskBoard project board is missing: ${project.path}`);
      seen.add(key);
      // Hidden projects still contribute live reservation capacity and Starting
      // reconciliation; only new selections are suppressed while hidden.
      projects.push({ ...project, priority: project.priority === "high" || project.priority === "low"
        ? project.priority : "normal", dispatchEnabled: !hidden.has(key) });
    }
    return projects;
  }

  private async readQueues(): Promise<QueueSnapshot[]> {
    if (!NodeFS.existsSync(TASKBOARD_CLI)) throw new Error("Local TaskBoard CLI missing.");
    try {
      const snapshots: QueueSnapshot[] = [];
      for (const project of this.projects()) {
        const output = await cli(TASKBOARD_CLI, [
          "--json", "--root", project.path, "task", "queue", "list",
        ]) as { schema?: string; boardRoot?: string; items?: QueueItem[]; observedAt?: string };
        if (output.schema !== "taskboard-dispatch-queue/v1" ||
            rootKey(output.boardRoot ?? "") !== rootKey(project.path) ||
            !Array.isArray(output.items)) {
          throw new Error(`TaskBoard ${project.name} returned an invalid dispatch queue snapshot.`);
        }
        snapshots.push({ boardRoot: project.path, projectName: project.name, projectId: project.id,
          items: output.items, projectPriority: project.priority ?? "normal",
          dispatchEnabled: project.dispatchEnabled });
        this.lastObservedAt = output.observedAt ?? new Date().toISOString();
      }
      this.snapshots = snapshots;
      const startingIds = new Set(snapshots.flatMap(board => board.items
        .filter(item => item.state === "starting" && item.reservationId)
        .map(item => item.reservationId!)));
      for (const id of this.startingFirstSeen.keys()) {
        if (!startingIds.has(id)) {
          this.startingFirstSeen.delete(id);
          this.startingLastAttempt.delete(id);
        }
      }
      // Snapshot polling is not evidence that a previous admission failure
      // has cleared. Keep diagnostics until a confirmed successful admission.
      const keys = new Set(snapshots.flatMap(board => board.items
        .filter(item => item.state !== "completed")
        .map(item => this.retryKey(board.boardRoot, item))));
      for (const key of this.definiteFailures.keys()) {
        if (!keys.has(key)) this.definiteFailures.delete(key);
      }
      this.syncReservations(true);
      this.scanCompletions(snapshots);
      return snapshots;
    } catch (error) {
      // Never admit another T3 automatic worker from a partial/unknown TaskBoard
      // inventory. Preserve the last known reservations but fail closed.
      this.syncReservations(false);
      throw error;
    }
  }

/** Queue completion is not the same as Done: verify the actual task frontmatter. */
  private scanCompletions(snapshots: QueueSnapshot[]) {
    const now = Date.now();
    if (now - this.lastCompletionScanAt < 60_000) return;
    this.lastCompletionScanAt = now;
    for (const board of snapshots) {
      for (const item of board.items) {
        if (item.state !== "completed" || item.legacyOpenRig) continue;
        const name = item.taskId + ".md";
        const active = NodePath.join(board.boardRoot, "Active", name);
        const archived = NodePath.join(board.boardRoot, "Archive", name);
        const file = NodeFS.existsSync(active) ? active : archived;
        try {
          const stat = NodeFS.statSync(file);
          if (stat.mtimeMs < now - 8 * 24 * 3_600_000 ||
              this.completionMtimes.get(file) === stat.mtimeMs) continue;
          const body = NodeFS.readFileSync(file, "utf8").split("\n---", 2)[0] ?? "";
          this.completionMtimes.set(file, stat.mtimeMs);
          const completion = completedQueueTask(item, body);
          if (completion !== null) {
            // Retain the old journal key for idempotent historical backfill.
            this.caffy.throughput.recordCompletion(
              `${rootKey(board.boardRoot)}:${item.taskId}:${completion.stamp}`, completion.at);
          }
        } catch { /* Cloud-synced task can move mid-scan; retry the next sweep. */ }
      }
    }
  }

  private startingSince(boardRoot: string, item: QueueItem): number {
    const requestId = item.reservationId!;
    const firstSeen = this.startingFirstSeen.get(requestId) ?? Date.now();
    this.startingFirstSeen.set(requestId, firstSeen);
    const hash = NodeCrypto.createHash("sha256")
      .update(rootKey(boardRoot) + "\0" + item.taskId)
      .digest("hex");
    const journal = NodePath.join(this.home, "userdata", "task-open-locks", `${hash}.json`);
    try {
      const saved = JSON.parse(NodeFS.readFileSync(journal, "utf8")) as { requestId?: string };
      if (saved.requestId === requestId) return Math.min(firstSeen, NodeFS.statSync(journal).mtimeMs);
    } catch { /* The TaskBoard reservation can precede its spawn journal. */ }
    return firstSeen;
  }

  private reservations(snapshots = this.snapshots): Array<{
    boardRoot: string; taskId: string; requestId: string;
    state: "reserved" | "starting" | "working";
    expiresAt: string | null; sessionId: string | null; holdUntil?: number;
  }> {
    const now = Date.now();
    return snapshots.flatMap(board => board.items.flatMap(item => {
      const state = item.state;
      if ((state !== "reserved" && state !== "starting" && state !== "working") ||
          !item.reservationId || item.legacyOpenRig) return [];
      const expiresAt = item.reservationExpiresAt ?? null;
      // An expired reservation which never entered Starting is not capacity.
      if (item.state === "reserved" && expiresAt &&
          Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now) return [];
      return [{
        boardRoot: board.boardRoot, taskId: item.taskId, requestId: item.reservationId,
        state, expiresAt, sessionId: state === "working" ? item.sessionId ?? null : null,
        ...(state === "starting" ? { holdUntil: this.startingSince(board.boardRoot, item) + STARTING_HOLD_MS } : {}),
      }];
    }));
  }

  private workingStartupHoldUntil(boardRoot: string, taskId: string, requestId: string): number {
    // The spawn journal predates the transition to Working and survives T3
    // restarts. An old Working claim is NOT a capacity reservation. Only the
    // first five minutes of a verified original startup need admission safety.
    const hash = NodeCrypto.createHash("sha256")
      .update(rootKey(boardRoot) + "\0" + taskId).digest("hex");
    const path = NodePath.join(this.home, "userdata", "task-open-locks", `${hash}.json`);
    try {
      const row = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {requestId?: string};
      if (row.requestId === requestId)
        return NodeFS.statSync(path).mtimeMs + STARTING_HOLD_MS;
    } catch { /* No durable receipt for this exact attempt. */ }
    // The in-process admission also covers the short interval before the
    // spawn journal is written, without resurrecting old claims after reboot.
    return (this.admittedStarts.get(requestId) ?? -STARTING_HOLD_MS) + STARTING_HOLD_MS;
  }

  private syncReservations(inventoryReady: boolean) {
    const now = Date.now();
    for (const [requestId, at] of this.admittedStarts)
      if (now - at >= STARTING_HOLD_MS) this.admittedStarts.delete(requestId);
    const pending = this.reservations().flatMap(row => {
      const until = row.state === "reserved"
        ? Date.parse(row.expiresAt ?? "")
        : row.state === "starting"
          ? row.holdUntil ?? 0
          : this.workingStartupHoldUntil(row.boardRoot, row.taskId, row.requestId);
      // Expired startup and ordinary Working task ownership must not consume
      // the live green-session count or permanently block queued tasks.
      if (!Number.isFinite(until) || until <= now) return [];
      return [{
        requestId: row.requestId, sessionId: row.sessionId, holdUntil: until,
      }];
    });
    this.caffy.setTaskReservations(pending, inventoryReady);
  }

  status() {
    const reservations = this.reservations();
    const quarantined = reservations.filter(row => row.state === "starting" &&
      row.holdUntil !== undefined && row.holdUntil <= Date.now());
    return {
      active: this.running,
      keepT3Busy: this.caffy.policyEnabled,
      observedAt: this.lastObservedAt,
      reservations,
      quarantined: quarantined.map(row => ({
        boardRoot: row.boardRoot, taskId: row.taskId, requestId: row.requestId,
        reason: "Unconfirmed startup quarantined; after 30 minutes without a live matching T3 session it is safely returned to Queue. Does not count against capacity.",
      })),
      lastError: this.lastError,
      lastIdleReason: this.lastIdleReason,
      managedWorkerWakes: [...this.managedWorkerWakes.values()].map(row => ({
        taskId: row.taskId, sessionId: row.sessionId, active: row.active,
        caffyStatus: (this.caffy.status(row.sessionId) as {paused?: boolean; lastError?: string | null} | null)
          ? {
            paused: (this.caffy.status(row.sessionId) as {paused?: boolean}).paused ?? false,
            lastError: (this.caffy.status(row.sessionId) as {lastError?: string | null}).lastError ?? null,
          } : null,
      })),
      lastAdmissionAt: this.lastAdmissionAt === null ? null : new Date(this.lastAdmissionAt).toISOString(),
      lastAdmissionAttemptAt: this.lastAdmissionAttemptAt === null ? null : new Date(this.lastAdmissionAttemptAt).toISOString(),
      pumpBusy: this.busy,
      pumpRunningMs: this.pumpStartedAt === null ? 0 : Date.now() - this.pumpStartedAt,
      lastPumpCompletedAt: this.lastPumpCompletedAt === null ? null : new Date(this.lastPumpCompletedAt).toISOString(),
      eligibleQueued: this.snapshots.reduce((n, board) => n + (board.dispatchEnabled ?
        board.items.filter(item => item.state === "queued" && item.readiness &&
          !item.claimed && !item.legacyOpenRig && UUID.test(item.queueRequest)).length : 0), 0),
      coolingDown: this.snapshots.flatMap(board => board.dispatchEnabled ? board.items
        .filter(item => item.state === "queued" && item.readiness && !item.claimed)
        .flatMap(item => {
          const failure = this.definiteFailures.get(this.retryKey(board.boardRoot, item));
          return failure && failure.retryAt > Date.now() ? [{
            boardRoot: board.boardRoot, taskId: item.taskId, attempts: failure.attempts,
            retryAt: new Date(failure.retryAt).toISOString(), reason: failure.reason,
          }] : [];
        }) : []),
      queued: this.snapshots.reduce((n, board) => n + board.items.filter(item =>
        item.state === "queued" && !item.claimed && !item.legacyOpenRig).length, 0),
      legacyOpenRig: this.snapshots.reduce((n, board) => n + board.items.filter(item =>
        item.legacyOpenRig).length, 0),
    };
  }

  /** A confirmed start or definite pre-spawn rejection releases the queue
   * lane. Recheck other tasks immediately; the periodic pump remains the
   * fallback if this one-shot tick is lost during a desktop suspension. */
  private requestFollowupPump() {
    if (!this.running || this.followupTimer !== null) return;
    this.followupTimer = setTimeout(() => {
      this.followupTimer = null;
      void this.pump();
    }, 1000);
    this.followupTimer.unref?.();
  }

  start() {
    if (this.running) return;
    this.running = true;
    let lastTick = Date.now();
    this.timer = setInterval(() => {
      const status = this.caffy.status();
      const hadWake = status != null && "entries" in status &&
        status.entries.some(row => (row.lastWakeAt ?? 0) > lastTick);
      lastTick = Date.now();
      if (!hadWake) void this.pump();
    }, PUMP_INTERVAL_MS);
    this.timer.unref?.();
    // Refresh TaskBoard-owned reservations immediately for accurate capacity;
    // delay only admission until T3's working-session inventory has recovered.
    void this.readQueues().catch(error => { this.lastError = String(error); });
    setTimeout(() => { void this.pump(); }, 12_000).unref?.();
  }

  close() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.followupTimer) clearTimeout(this.followupTimer);
    this.followupTimer = null;
    this.caffy.setTaskReservations([], false);
  }

  private async taskCommand(boardRoot: string, args: string[]) {
    return await cli(TASKBOARD_CLI, ["--json", "--root", boardRoot, ...args]);
  }

  private async startReserved(boardRoot: string, item: QueueItem, requestId: string) {
    this.admittedStarts.set(requestId, Date.now());
    await this.taskCommand(boardRoot, [
      "task", "queue", "starting", item.taskId, "--request-id", requestId,
    ]);
    await this.readQueues();
    const current = this.snapshots.find(board => rootKey(board.boardRoot) === rootKey(boardRoot))
      ?.items.find(row => row.taskId === item.taskId);
    if (!current || current.state !== "starting" || current.reservationId !== requestId) return;
    await this.starting(current, boardRoot, requestId);
  }

  private async starting(item: QueueItem, boardRoot: string, requestId: string) {
    if (!this.running) return;
    // The live green-session count is the admission limit, including when
    // resuming a previously reserved task after other workers became active.
    const capacity = await this.caffy.capacity().catch(() => null);
    if (!capacity || capacity.unknown !== 0 || capacity.working >= capacity.limit) {
      this.lastIdleReason = capacity?.reason ?? "Green-session count unavailable; spawn deferred.";
      return;
    }
    const result = await cli("node.exe", [
      NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
    ], JSON.stringify({
      action: "open-task",
      taskRef: { board: boardRoot, id: item.taskId },
      intent: "implement", kind: "chatgpt", background: true,
      requireQueue: true, queueRequest: item.queueRequest, reservationId: requestId,
      home: this.home,
    }), 115_000) as { status?: string; sessionId?: string; message?: string; definitelyNotCreated?: boolean; created?: boolean }

    if (result.definitelyNotCreated === true) {
      await this.taskCommand(boardRoot, [
        "task", "queue", "failed", item.taskId,
        "--queue-request", item.queueRequest,
        "--request-id", requestId,
        "--reason", result.message ?? "T3 definitively rejected the start before creating a session",
        "--confirmed-not-created",
      ]);
      this.backoffDefiniteFailure(boardRoot, item, result.message ??
        `T3 rejected start: ${result.status ?? "unknown"}`);
      this.lastError = `Task ${item.taskId}: ${result.status ?? "start rejected"} before creation; safely requeued with retry backoff.`;
      await this.readQueues();
      this.requestFollowupPump();
      return;
    }
    if (["created", "opened", "prompt_unknown"].includes(result.status ?? "")) {
      if (result.created === true && result.sessionId && UUID.test(result.sessionId))
        this.caffy.throughput.recordSession(`task:${rootKey(boardRoot)}:${item.taskId}:${requestId}`);
      this.lastAdmissionAt = Date.now();
      this.lastIdleReason = null;
      this.definiteFailures.delete(this.retryKey(boardRoot, item));
      this.lastError = result.status === "prompt_unknown"
        ? `Task ${item.taskId}: session created; initial prompt delivery needs inspection.`
        : null;
      await this.readQueues();
      this.requestFollowupPump();
      return;
    }
    // Unknown / in-flight outcomes stay Starting with the same reservation ID.
    // The next pump calls open-task again; its journal performs read-only
    // reconciliation by the original T3 spawn request ID before any new send.
    this.lastError = `Task ${item.taskId}: ${result.status ?? "unknown"}; retaining the same Starting reservation.`;
  }

  /** Legacy claimed guests (from pre-delivery-acknowledgment launches) can
   * retain In Progress forever. Retire only unbootstrapped, blank, idle guests
   * after two minutes, with a durable close receipt before reclaiming the
   * exact TaskBoard reservation. Never replay the original UNKNOWN prompt. */
  private async recoverUnstartedGuests(snapshots: QueueSnapshot[]): Promise<void> {
    NodeFS.mkdirSync(this.retiredGuestDir, { recursive: true });
    const outstanding = NodeFS.readdirSync(this.retiredGuestDir)
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    const closingSessionIds = new Set<string>();
    for (const name of outstanding) {
      const file = NodePath.join(this.retiredGuestDir, name);
      let receipt: RetiredGuestReceipt;
      try { receipt = JSON.parse(NodeFS.readFileSync(file, "utf8")) as RetiredGuestReceipt; }
      catch { continue; }
      const item = snapshots.find(board => rootKey(board.boardRoot) === rootKey(receipt.boardRoot))
        ?.items.find(row => row.taskId === receipt.taskId);
      if (!item || item.state !== "working" ||
          item.queueRequest !== receipt.queueRequest ||
          item.reservationId !== receipt.requestId ||
          item.sessionId !== receipt.sessionId ||
          (item.claimed && item.claimedBy !== `t3:${receipt.sessionId}`)) {
        NodeFS.rmSync(file, { force: true });
        continue;
      }
      const status = await cli("node.exe", [
        NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
      ], JSON.stringify({
        action: "close_status", sessionId: receipt.sessionId, home: this.home,
      }), 15_000) as {status?: string; persisted?: boolean};
      if (status.status === "closed" && status.persisted === true) {
        await this.taskCommand(receipt.boardRoot, [
          "task", "queue", "reclaim", receipt.taskId,
          "--queue-request", receipt.queueRequest,
          "--request-id", receipt.requestId,
          "--session-id", receipt.sessionId,
          "--reason", "Unbootstrapped T3 guest retired after one hour without an assistant response.",
          "--confirmed-session-closed",
        ]);
        NodeFS.rmSync(file, { force: true });
        await this.readQueues();
      } else if (status.status !== "closing") {
        let response: {closeAccepted?: boolean; closed?: boolean};
        try { response = await cli("node.exe", [
          NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
        ], JSON.stringify({
          action: "change_state", sessionId: receipt.sessionId, state: "closed",
          home: this.home,
        }), 25_000) as {closeAccepted?: boolean; closed?: boolean}; }
        catch (error) {
          this.rejectedUnstartedGuests.set(receipt.sessionId, Date.now() + 10 * 60_000);
          NodeFS.rmSync(file, {force: true}); // Definitive refusal; try another eligible task.
          throw error;
        }
        if (!response.closeAccepted && !response.closed)
          throw new Error(`Retiring unstarted T3 guest ${receipt.sessionId} was not accepted`);
      }
      // A closing guest can take longer than one pump. Check other guests
      // without selecting this same request recursively until it is closed.
      if (status.status !== "closing") return;
      closingSessionIds.add(receipt.sessionId);
    }

    if (Date.now() - this.lastUnstartedGuestCheckAt < 30_000) return;
    this.lastUnstartedGuestCheckAt = Date.now();
    // Recovery is maintenance, not new admission: running at capacity is
    // precisely when an abandoned worker needs to be retired.
    const listed = await cli("node.exe", [
      NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
    ], JSON.stringify({
      action: "list", which: "all", includeHidden: true, home: this.home,
    }), 25_000) as {sessions?: Array<{
      id: string; spawnRequestId?: string; autoClose?: boolean; humanControlled?: boolean;
      autoCloseExempt?: boolean; borderColor?: string | null; verificationPending?: boolean;
      hidden?: boolean; closedAt?: unknown; conversationId?: string | null;
      observedGuestUrl?: string | null;
      bootstrapIdentity?: {state?: string; conversationId?: string};
      binding?: {boundAt?: string; taskRef?: {board?: string; id?: string}};
      lastRole?: string | null; lastWorkingAt?: number | null; totalTurns?: number | null;
      activity?: string; status?: string; statusObservedAt?: string;
    }>; total?: number; hasMore?: boolean; incomplete?: boolean };
    if (!Array.isArray(listed.sessions) || listed.hasMore || listed.incomplete ||
        (listed.total !== undefined && listed.total !== listed.sessions.length)) return;
    const byId = new Map(listed.sessions.map(session => [session.id, session]));
    const now = Date.now();
    const candidates = snapshots.flatMap(board => board.dispatchEnabled ? board.items
      .filter(item => item.state === "working" && item.sessionId &&
        item.reservationId && UUID.test(item.queueRequest) && !item.legacyOpenRig &&
        (!item.claimed || item.claimedBy === `t3:${item.sessionId}`))
      .map(item => ({ boardRoot: board.boardRoot, item })) : [])
      .sort((a, b) => a.item.created.localeCompare(b.item.created));
    for (const {boardRoot, item} of candidates) {
      const session = byId.get(item.sessionId!);
      if (!session || closingSessionIds.has(item.sessionId!) ||
          (this.rejectedUnstartedGuests.get(item.sessionId!) ?? 0) > now ||
          session.spawnRequestId !== item.reservationId ||
          session.binding?.taskRef?.id !== item.taskId ||
          !session.binding?.taskRef?.board ||
          rootKey(session.binding.taskRef.board) !== rootKey(boardRoot) ||
          session.bootstrapIdentity?.state !== "awaiting_marker" ||
          session.bootstrapIdentity.conversationId || session.conversationId ||
          session.hidden || session.humanControlled ||
          session.autoCloseExempt || session.borderColor || session.verificationPending ||
          !session.autoClose ||
          ![null, undefined, "user"].includes(session.lastRole) ||
          (session.closedAt == null &&
            !/^https:\/\/chatgpt\.com\/?(?:[?#].*)?$/i.test(session.observedGuestUrl ?? "")) ||
          (session.lastWorkingAt != null && session.lastWorkingAt > 0) ||
          (session.totalTurns != null && session.totalTurns > 0) ||
          session.activity === "working" ||
          (session.closedAt == null &&
            !["new", "pending_or_stalled", "done_or_idle", "idle"].includes(session.status ?? ""))) continue;
      const boundAt = Date.parse(session.binding.boundAt ?? "");
      const observedAt = Date.parse(session.statusObservedAt ?? "");
      if (!Number.isFinite(boundAt) || now - boundAt < UNSTARTED_GUEST_GRACE_MS ||
          (session.closedAt == null && (!Number.isFinite(observedAt) ||
            observedAt > now + 1_000 || now - observedAt > 15_000))) continue;
      const receipt: RetiredGuestReceipt = {
        boardRoot, taskId: item.taskId, queueRequest: item.queueRequest,
        requestId: item.reservationId!, sessionId: item.sessionId!,
      };
      // A separately verified UI close may precede this sweep. Its server
      // tombstone is positive closure evidence; reclaim without asking the
      // (already absent) browser to close again.
      if (session.closedAt != null) {
        await this.taskCommand(boardRoot, [
          "task", "queue", "reclaim", receipt.taskId,
          "--queue-request", receipt.queueRequest,
          "--request-id", receipt.requestId,
          "--session-id", receipt.sessionId,
          "--reason", "Unbootstrapped blank ChatGPT guest closed; original queue slot recovered.",
          "--confirmed-session-closed",
        ]);
        await this.readQueues();
        return;
      }
      const hash = NodeCrypto.createHash("sha256")
        .update(rootKey(boardRoot) + "\\0" + receipt.taskId + "\\0" + receipt.requestId)
        .digest("hex");
      const file = NodePath.join(this.retiredGuestDir, `${hash}.json`);
      NodeFS.writeFileSync(file + ".tmp", JSON.stringify(receipt), {encoding: "utf8", flush: true});
      NodeFS.renameSync(file + ".tmp", file);
      await this.recoverUnstartedGuests(snapshots);
      return;
    }
  }

  /** A Starting entry without a live T3 session is permanently stranded by the
   * original UNKNOWN-spawn rule. After the in-flight request is far beyond its
   * timeout, reconcile against the complete T3 registry before returning it to
   * Queue. Never resubmit or clear an unconfirmed request directly. */
  private async recoverQuarantinedStarts(snapshots: QueueSnapshot[]): Promise<void> {
    if (Date.now() - this.lastAbandonedStartCheckAt < 60_000) return;
    this.lastAbandonedStartCheckAt = Date.now();
    const now = Date.now();
    const stranded = snapshots.flatMap(board => board.items
      .filter(item => item.state === "starting" && item.reservationId &&
        UUID.test(item.queueRequest) && !item.legacyOpenRig && !item.claimed &&
        item.readiness && now - this.startingSince(board.boardRoot, item) >= UNSTARTED_GUEST_GRACE_MS)
      .map(item => ({boardRoot: board.boardRoot, projectPriority: board.projectPriority, item})))
      .sort((a, b) => (a.item.priority === "urgent" ? 0 : 1) -
          (b.item.priority === "urgent" ? 0 : 1) ||
        (a.projectPriority === "high" ? 0 : a.projectPriority === "low" ? 2 : 1) -
          (b.projectPriority === "high" ? 0 : b.projectPriority === "low" ? 2 : 1) ||
        a.item.created.localeCompare(b.item.created));
    if (!stranded.length) return;
    const listed = await cli("node.exe", [
      NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
    ], JSON.stringify({
      action: "list", which: "all", includeHidden: true, home: this.home,
    }), 25_000) as {sessions?: Array<{
      id: string; spawnRequestId?: string;
      binding?: {taskRef?: {board?: string; id?: string}};
      closedAt?: unknown; conversationId?: string | null;
      bootstrapIdentity?: {state?: string; conversationId?: string | null};
      lastRole?: string | null; totalTurns?: number | null;
    }>; hasMore?: boolean; incomplete?: boolean; total?: number};
    if (!Array.isArray(listed.sessions) || listed.hasMore || listed.incomplete ||
        (listed.total !== undefined && listed.total !== listed.sessions.length)) {
      throw new Error("Stale Starting recovery requires a complete T3 session registry");
    }
    for (const {boardRoot, item} of stranded) {
      // A previous session bound to this task is NOT proof that the current
      // Starting request spawned anything. Only this exact requestId prevents
      // verified orphan recovery. Otherwise one old task session can block a
      // priority task indefinitely, allowing lower-priority boards to launch.
      const matches = sessionsForStartRequest(listed.sessions, item.reservationId!);
      if (matches.length !== 0) {
        // Only a bootstrapped, positively bound conversation becomes a worker.
        // A browser slot with an UNKNOWN first message keeps its reservation
        // until it is definitively closed, never an In Progress task claim.
        const matched = matches.length === 1 &&
          matches[0]?.spawnRequestId === item.reservationId &&
          matches[0]?.binding?.taskRef?.id === item.taskId &&
          matches[0]?.binding?.taskRef?.board &&
          rootKey(matches[0].binding.taskRef.board) === rootKey(boardRoot) &&
          UUID.test(matches[0].id) ? matches[0] : null;
        if (matched?.closedAt != null && !matched.conversationId &&
            matched.bootstrapIdentity?.state === "awaiting_marker") {
          await this.taskCommand(boardRoot, [
            "task", "queue", "abandon", item.taskId,
            "--queue-request", item.queueRequest,
            "--request-id", item.reservationId!,
            "--reason", "Unbootstrapped ChatGPT guest closed before first prompt; returned to Queue.",
            "--verified-no-live-session",
          ]);
          await this.readQueues();
          return;
        } else if (matched?.closedAt == null &&
            matched?.bootstrapIdentity?.state === "registered" &&
            matched.conversationId &&
            matched.bootstrapIdentity.conversationId === matched.conversationId &&
            matched.lastRole === "assistant" && (matched.totalTurns ?? 0) >= 1) {
          await this.taskCommand(boardRoot, [
            "task", "queue", "working", item.taskId,
            "--queue-request", item.queueRequest,
            "--request-id", item.reservationId!,
            "--session-id", matched.id,
          ]);
          await this.readQueues();
          return;
        }
        // An ambiguous existing guest may require manual intervention, but
        // must never starve the other Starting requests in this sweep.
        continue;
      }
      if (now - this.startingSince(boardRoot, item) < 30 * 60_000) continue;
      await this.taskCommand(boardRoot, [
        "task", "queue", "abandon", item.taskId,
        "--queue-request", item.queueRequest,
        "--request-id", item.reservationId!,
        "--reason", "30-minute Starting request has no live T3 spawn/session in complete registry; returned to Queue.",
        "--verified-no-live-session",
      ]);
      await this.readQueues();
      return; // At most one task per recovery sweep.
    }
  }

  /** TaskBoard may release an abandoned worker claim back to AI Ready while
   * its historical queue receipt still says Working. A never-bootstrapped old
   * guest is not an active owner; return that exact intent to Queue only after
   * checking the complete T3 registry for a still-working session. */
  private async recoverReleasedWorkers(snapshots: QueueSnapshot[]): Promise<void> {
    if (Date.now() - this.lastReleasedWorkerCheckAt < 30_000) return;
    this.lastReleasedWorkerCheckAt = Date.now();
    const candidates = snapshots.flatMap(board => board.items
      .filter(item => item.state === "working" && item.readiness && !item.claimed &&
        item.sessionId && UUID.test(item.sessionId) && item.reservationId &&
        UUID.test(item.queueRequest) && !item.legacyOpenRig)
      .map(item => ({boardRoot: board.boardRoot, item})));
    if (!candidates.length) return;
    const listed = await cli("node.exe", [
      NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
    ], JSON.stringify({
      action: "list", which: "all", includeHidden: true, home: this.home,
    }), 25_000) as {sessions?: Array<{
      id: string; spawnRequestId?: string; status?: string; activity?: string;
      statusObservedAt?: string; conversationId?: string | null;
      bootstrapIdentity?: {state?: string; conversationId?: string | null};
      binding?: {boundAt?: string; taskRef?: {board?: string; id?: string}};
      lastRole?: string | null; lastWorkingAt?: number | null; totalTurns?: number | null;
    }>; total?: number; hasMore?: boolean; incomplete?: boolean};
    if (!Array.isArray(listed.sessions) || listed.hasMore || listed.incomplete ||
        (listed.total !== undefined && listed.total !== listed.sessions.length)) return;
    const now = Date.now();
    for (const {boardRoot, item} of candidates) {
      const matching = listed.sessions.filter(s =>
        s.id === item.sessionId ||
        (s.binding?.taskRef?.id === item.taskId && s.binding?.taskRef?.board &&
          rootKey(s.binding.taskRef.board) === rootKey(boardRoot)));
      if (matching.length > 1) continue; // Another guest may still own this task.
      const session = matching[0];
      // A newly allocated guest might not have appeared in the registry yet.
      // Without a matching live guest, require an old durable spawn journal
      // before treating its absence as conclusive.
      if (!session && now - this.startingSince(boardRoot, item) < 30 * 60_000) continue;
      if (session) {
        const bound = Date.parse(session.binding?.boundAt ?? "");
        const observed = Date.parse(session.statusObservedAt ?? "");
        if (session.id !== item.sessionId ||
            session.spawnRequestId !== item.reservationId ||
            session.binding?.taskRef?.id !== item.taskId ||
            !session.binding?.taskRef?.board ||
            rootKey(session.binding.taskRef.board) !== rootKey(boardRoot) ||
            session.bootstrapIdentity?.state !== "awaiting_marker" ||
            session.conversationId || session.bootstrapIdentity.conversationId ||
            session.lastRole != null ||
            (session.lastWorkingAt != null && session.lastWorkingAt > 0) ||
            (session.totalTurns != null && session.totalTurns > 0) ||
            !["new", "unavailable"].includes(session.status ?? "") ||
            session.activity === "working" ||
            !Number.isFinite(bound) || now - bound < 30 * 60_000 ||
            !Number.isFinite(observed) || observed > now + 1000 ||
            now - observed > 15_000) continue;
      }
      // The old guest is absent or was never mounted/bootstrapped. The
      // TaskBoard claim is already released; no active worker is displaced.
      await this.taskCommand(boardRoot, [
        "task", "queue", "requeue-released", item.taskId,
        "--queue-request", item.queueRequest,
        "--request-id", item.reservationId!,
        "--session-id", item.sessionId!,
        "--reason", "Released AI Ready task has no active or bootstrapped T3 worker; Queue recovered.",
        "--verified-old-session-inactive",
      ]);
      await this.readQueues();
      return;
    }
  }

  /** A queued worker may answer once and leave its TaskBoard task unfinished.
   * Use existing Caffy queued-idle wakes, rather than allocating a duplicate
   * ChatGPT guest. Only exact, idle, assistant-responded queue-bound workers
   * are eligible. Durable ownership means we never override manual Caffy and
   * can stop only monitors that this coordinator created. */
  private scheduleWorkerWakeMaintenance(snapshots: QueueSnapshot[]) {
    // Guarded Caffy registration may mount a cold browser and take 95 seconds.
    // It must NEVER hold the TaskBoard admission pump or prevent new work
    // from filling a free slot while a previous worker is being resumed.
    if (!this.running || this.workerWakeScanRunning) return;
    this.workerWakeScanRunning = true;
    void this.reconcileManagedWorkerWakes(snapshots).catch(error => {
      this.lastError = `Task worker continuation: ${String(error)}`;
    }).finally(() => { this.workerWakeScanRunning = false; });
  }

  private cleanupManagedWorkerWakes(snapshots: QueueSnapshot[]) {
    if (!this.workerWakeJournalReady || !this.managedWorkerWakes.size) return;
    for (const [id, wake] of this.managedWorkerWakes) {
      const stillOwned = snapshots.some(board =>
        rootKey(board.boardRoot) === rootKey(wake.boardRoot) &&
        board.items.some(item => item.taskId === wake.taskId &&
          item.state === "working" && item.reservationId === wake.requestId &&
          item.sessionId === id && item.claimed && item.claimedBy === `t3:${id}`));
      if (stillOwned) continue;
      const monitor = this.caffy.status(id) as {
        conversationId?: string; mode?: string;
      } | null;
      if (monitor?.conversationId === wake.conversationId && monitor.mode === "queued")
        this.caffy.stop(id, "agent");
      this.managedWorkerWakes.delete(id);
      this.saveWorkerWakes();
    }
  }

  private async reconcileManagedWorkerWakes(snapshots: QueueSnapshot[]): Promise<void> {
    if (!this.workerWakeJournalReady || Date.now() - this.lastWorkerWakeScanAt < 30_000) return;
    this.lastWorkerWakeScanAt = Date.now();
    const currentClaims = snapshots.flatMap(board => board.items
      .filter(item => item.state === "working" && item.sessionId &&
        item.claimed && item.claimedBy === `t3:${item.sessionId}` &&
        item.reservationId && !item.legacyOpenRig)
      .map(item => ({boardRoot: board.boardRoot, item})));
    if (!currentClaims.length) return;
    const listed = await cli("node.exe", [
      NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
    ], JSON.stringify({
      action: "list", which: "all", includeHidden: true, home: this.home,
    }), 25_000) as {
      sessions?: Array<{
        id: string; conversationId?: string | null; spawnRequestId?: string;
        autoClose?: boolean; humanControlled?: boolean; autoCloseExempt?: boolean;
        hidden?: boolean; closedAt?: unknown; lastRole?: string | null;
        totalTurns?: number | null; activity?: string; status?: string;
        statusObservedAt?: string; lastWorkingAt?: number | null;
        bootstrapIdentity?: {state?: string; conversationId?: string | null};
        binding?: {boundAt?: string; taskRef?: {board?: string; id?: string}};
      }>; total?: number; hasMore?: boolean; incomplete?: boolean;
    };
    if (!Array.isArray(listed.sessions) || listed.hasMore || listed.incomplete ||
        (listed.total !== undefined && listed.total !== listed.sessions.length)) return;
    const now = Date.now();
    const stopped = (this.caffy.status() as {
      agentStops?: Array<{sessionId?: string; browserSessionId?: string; publicSessionId?: string}>;
    }).agentStops ?? [];
    for (const {boardRoot, item} of currentClaims) {
      const session = listed.sessions.find(row => row.id === item.sessionId);
      if (!session || !UUID.test(session.conversationId ?? "") ||
          session.bootstrapIdentity?.state !== "registered" ||
          (session.bootstrapIdentity.conversationId &&
            session.bootstrapIdentity.conversationId !== session.conversationId) ||
          session.spawnRequestId !== item.reservationId ||
          session.binding?.taskRef?.id !== item.taskId ||
          !session.binding?.taskRef?.board ||
          rootKey(session.binding.taskRef.board) !== rootKey(boardRoot) ||
          !session.autoClose || session.autoCloseExempt || session.humanControlled ||
          session.hidden || session.closedAt != null ||
          session.lastRole !== "assistant" || (session.totalTurns ?? 0) < 1 ||
          session.activity !== "idle" ||
          !["done_or_idle", "pending_or_stalled"].includes(session.status ?? "")) continue;
      const observed = Date.parse(session.statusObservedAt ?? "");
      const bound = Date.parse(session.binding.boundAt ?? "");
      const activity = session.lastWorkingAt && session.lastWorkingAt > 0
        ? Math.max(bound, session.lastWorkingAt) : bound;
      if (!Number.isFinite(observed) || now - observed > 15_000 || observed > now + 1000 ||
          !Number.isFinite(activity) || now - activity < 90_000) continue;
      const id = session.id;
      const journal = this.managedWorkerWakes.get(id);
      if (journal && (journal.active || now - journal.lastAttemptAt < 90_000)) continue;
      if (!journal && stopped.some(row =>
        row.sessionId === id || row.browserSessionId === id || row.publicSessionId === id)) continue;
      const existing = this.caffy.status(id) as {
        mode?: string; conversationId?: string;
      } | null;
      if (existing && (!journal || existing.mode !== "queued" ||
          existing.conversationId !== session.conversationId)) continue;
      const wake: ManagedWorkerWake = journal ?? {
        boardRoot, taskId: item.taskId, requestId: item.reservationId!,
        sessionId: id, conversationId: session.conversationId!,
        beginAt: now + 60_000, lastAttemptAt: now, active: false,
      };
      wake.lastAttemptAt = now;
      this.managedWorkerWakes.set(id, wake);
      this.saveWorkerWakes(); // Persist exact ownership before scheduling.
      try {
        if (!this.running) return;
        if (!existing) {
          await this.caffy.set({
            sessionId: id, conversationId: wake.conversationId,
            mode: "queued", onceOnly: false, keepAwake: true,
            beginAt: Math.max(wake.beginAt, Date.now() + 30_000),
          });
        }
        const taskStillClaimed = this.snapshots.some(board =>
          rootKey(board.boardRoot) === rootKey(boardRoot) &&
          board.items.some(current => current.taskId === item.taskId &&
            current.state === "working" && current.reservationId === item.reservationId &&
            current.sessionId === id && current.claimed &&
            current.claimedBy === `t3:${id}`));
        if (!this.running || !taskStillClaimed) {
          this.caffy.stop(id, "agent");
          this.managedWorkerWakes.delete(id);
          this.saveWorkerWakes();
          return;
        }
        wake.active = true;
        this.saveWorkerWakes();
        this.lastIdleReason = `Queued Caffy now maintains unfinished ${item.taskId} in its existing T3 worker; idle work will be resumed when capacity permits.`;
      } catch (error) {
        this.lastError = `Automatic continuation for ${item.taskId}: ${String(error)}`;
        this.saveWorkerWakes();
      }
      return; // Bound one guarded registration per sweep.
    }
  }

  /** Recover ONLY task spawns whose persisted first message definitely never
   * reached ChatGPT. UNKNOWN submissions remain untouched to avoid duplicates. */
  private async recoverConfirmedUnsent(snapshots: QueueSnapshot[]): Promise<void> {
    if (Date.now() - this.lastPromptRecoveryAt < 30_000) return;
    this.lastPromptRecoveryAt = Date.now();
    const working = snapshots.flatMap(board => board.items
      .filter(item => item.state === "working" && item.sessionId && item.reservationId &&
        item.claimed && item.claimedBy === `t3:${item.sessionId}` && !item.legacyOpenRig)
      .map(item => ({ boardRoot: board.boardRoot, item })));
    if (!working.length) return;
    const listed = await cli("node.exe", [NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs")],
      JSON.stringify({ action: "list", which: "all", includeHidden: true, home: this.home }),
      25_000) as { sessions?: Array<{ id: string; spawnRequestId?: string;
        binding?: {boundAt?: string};
        promptDelivery?: string; sendAttempted?: boolean | null }> };
    const sessions = new Map((listed.sessions ?? []).map(s => [s.id, s]));
    const candidate = working.find(({ item }) => {
      const session = sessions.get(item.sessionId!);
      const bound = Date.parse(session?.binding?.boundAt ?? "");
      // Old never-started guests are retired and requeued, not repeatedly
      // resubmitted; a slow old prompt repair used to block new admissions.
      return session?.spawnRequestId === item.reservationId &&
        session?.promptDelivery === "not_sent" && session.sendAttempted === false &&
        Number.isFinite(bound) && Date.now() - bound < 2 * 60_000 &&
        (this.promptRecoveryAttempts.get(item.reservationId!) ?? 0) < 3;
    });
    if (!candidate) return;
    const { item, boardRoot } = candidate;
    this.promptRecoveryAttempts.set(item.reservationId!,
      (this.promptRecoveryAttempts.get(item.reservationId!) ?? 0) + 1);
    await cli("node.exe", [NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs")],
      JSON.stringify({
        action: "open-task", taskRef: { board: boardRoot, id: item.taskId },
        intent: "implement", kind: "chatgpt", background: true,
        requireQueue: true, queueRequest: item.queueRequest,
        reservationId: item.reservationId, home: this.home,
      }), 35_000);
  }

  /** Count live workers from every T3 session, not just auto-queued TaskBoard claims. */
  private async liveSessionBoardOwners(boards: QueueSnapshot[]): Promise<Map<string, string>> {
    if (Date.now() - this.lastSessionOwnerScanAt < 30_000)
      return new Map(this.sessionBoardOwners);
    try {
      const listed = await cli("node.exe", [
        NodePath.join(ROOT, "scripts", "taskboard-dispatch.mjs"),
      ], JSON.stringify({
        action: "list", which: "all", includeHidden: true, home: this.home,
      }), 25_000) as {
        sessions?: Array<{
          id: string; project?: string | null;
          binding?: {taskRef?: {board?: string}};
        }>;
        total?: number; hasMore?: boolean; incomplete?: boolean;
      };
      if (!Array.isArray(listed.sessions) || listed.hasMore || listed.incomplete ||
          (listed.total !== undefined && listed.total !== listed.sessions.length))
        throw new Error("T3 session inventory incomplete");

      this.sessionBoardOwners = boardOwnersFromSessions(boards, listed.sessions);
      this.lastSessionOwnerScanAt = Date.now();
    } catch (error) {
      // Retain known bindings; the queue snapshot remains a fallback for
      // queued workers. Missing registry metadata must not stop dispatch.
      this.lastError = `Project worker load lookup failed: ${String(error)}`;
      this.lastSessionOwnerScanAt = Date.now() - 15_000;
    }
    return new Map(this.sessionBoardOwners);
  }

  async pump() {
    if (!this.running) return;
    if (this.busy) {
      if (this.pumpStartedAt !== null && Date.now() - this.pumpStartedAt > PUMP_STUCK_MS) {
        this.lastError = "TaskBoard dispatcher has been in one pump too long; waiting for bounded exact-request reconciliation rather than risking duplicate workers.";
      }
      return;
    }
    this.busy = true;
    this.pumpStartedAt = Date.now();
    try {
      let snapshots = await this.readQueues();
      if (!this.running) return;
      try { this.cleanupManagedWorkerWakes(snapshots); }
      catch (error) { this.lastError = `Managed Caffy cleanup: ${String(error)}`; }
      // Recover a durable Starting request even when admission is paused. It
      // may already have created a worker, so its exact request must reconcile.
      const starting = snapshots.flatMap(board => board.items
        .filter(item => item.state === "starting" && item.reservationId && !item.legacyOpenRig)
        .map(item => ({ boardRoot: board.boardRoot, item })));
      const now = Date.now();
      const nextStarting = starting.find(({ boardRoot, item }) => {
        const requestId = item.reservationId!;
        return now < this.startingSince(boardRoot, item) + STARTING_HOLD_MS &&
          now - (this.startingLastAttempt.get(requestId) ?? 0) >= STARTING_RECHECK_MS;
      });
      if (nextStarting) {
        const { boardRoot, item } = nextStarting;
        this.startingLastAttempt.set(item.reservationId!, now);
        try { await this.starting(item, boardRoot, item.reservationId!); }
        catch (error) { this.lastError = `Starting ${item.taskId}: ${String(error)}`; }
        snapshots = await this.readQueues();
        if (!this.running) return;
      }
      // Full-capacity maintenance must still run, especially when the slot
      // is occupied by a ghost guest. But if there is free capacity and a
      // fresh queued task, admit it before doing slow recovery I/O.
      if (this.caffy.policyEnabled) {
        // Recover stranded ! Priority requests even with spare capacity and
        // other queued tasks. Otherwise routine work can bypass a high-priority
        // task that was left Starting after a failed creation.
        const urgentStranded = snapshots.some(board => board.dispatchEnabled &&
          board.items.some(item => item.priority === "urgent" && item.state === "starting" &&
            !!item.reservationId && item.readiness && !item.claimed &&
            Date.now() - this.startingSince(board.boardRoot, item) >= UNSTARTED_GUEST_GRACE_MS));
        if (urgentStranded) {
          try { await this.recoverQuarantinedStarts(snapshots); }
          catch (error) { this.lastError = `Priority Starting recovery: ${String(error)}`; }
          snapshots = this.snapshots;
        }
        const readyQueued = snapshots.some(board => board.dispatchEnabled &&
          board.items.some(item => item.state === "queued" && item.readiness &&
            !item.claimed && !item.legacyOpenRig && UUID.test(item.queueRequest)));
        const freeCapacity = (await this.caffy.capacity().catch(() => null))?.admissible ?? false;
        if (!readyQueued || !freeCapacity) {
          try { await this.recoverUnstartedGuests(snapshots); }
          catch (error) {
            // A guest whose native draft cannot be verified must not prevent
            // independent orphaned Starting requests from recovering.
            this.lastError = `Unstarted guest recovery: ${String(error)}`;
          }
          snapshots = this.snapshots;
          if (!urgentStranded) {
            try { await this.recoverQuarantinedStarts(snapshots); }
            catch (error) { this.lastError = `Starting recovery: ${String(error)}`; }
            snapshots = this.snapshots;
          }
          try { await this.recoverReleasedWorkers(snapshots); }
          catch (error) { this.lastError = `Released worker recovery: ${String(error)}`; }
          snapshots = this.snapshots;
        }
      }
      // Old ambiguous starts remain in TaskBoard for exact-request recovery,
      // but stop consuming capacity or repeatedly blocking unrelated launches.
      if (!this.caffy.policyEnabled) return;

      // Resume an unexpired Reserved task, or replace an expired lease.
      const reserved = snapshots.flatMap(board => board.dispatchEnabled ? board.items
        .filter(item => item.state === "reserved" && item.reservationId && !item.legacyOpenRig)
        .map(item => ({ boardRoot: board.boardRoot, item })) : []);
      if (reserved.length) {
        const next = reserved[0]!;
        const expiry = Date.parse(next.item.reservationExpiresAt ?? "");
        const liveLease = Number.isFinite(expiry) && expiry > Date.now();
        if (liveLease) {
          this.syncReservations(true);
          // The reservation already occupies one slot, so admissible=false
          // at precisely 3/3 is expected. But a human may have started more
          // workers since the reservation was made. Never move Reserved to
          // Starting if actual workers + all reservations now exceed the cap.
          const capacity = await this.caffy.capacity().catch(() => null);
          if (!capacity || capacity.unknown > 0 ||
              capacity.used >= capacity.limit) return;
          await this.startReserved(next.boardRoot, next.item, next.item.reservationId!);
          return;
        }
        // The previous lease never reached Starting, so no spawn was authorized.
        // Give unloaded queued-Caffy recipients first use of a newly free slot.
        // The TaskBoard and Caffy queues share one atomic admission gate.
        const requestId = NodeCrypto.randomUUID();
        if (!(await this.caffy.acquireAutomaticAdmission(requestId, undefined, false, `task:${next.item.taskId}`))) return;
        try {
          await this.taskCommand(next.boardRoot, [
            "task", "queue", "reserve", next.item.taskId,
            "--queue-request", next.item.queueRequest,
            "--request-id", requestId,
            "--lease-seconds", String(RESERVATION_LEASE_SECONDS),
          ]);
          await this.readQueues();
          await this.startReserved(next.boardRoot, next.item, requestId);
        } finally { this.caffy.releaseAutomaticAdmission(requestId); }
        return;
      }

      const queued = snapshots.flatMap(board => board.dispatchEnabled ? board.items
        .filter(item => item.state === "queued" && item.readiness && !item.claimed &&
          !item.legacyOpenRig && UUID.test(item.queueRequest))
        .map(item => ({ boardRoot: board.boardRoot, projectPriority: board.projectPriority, item })) : []);
      // The queue snapshot omits manually started and non-queued workers.
      // Map ALL green T3 sessions to their boards, using verified task bindings
      // first, then unambiguous project names. Historical idle claims do not count.
      const workingIds = new Set((await this.caffy.capacity().catch(() => null))?.workingIds ?? []);
      const sessionOwners = await this.liveSessionBoardOwners(snapshots);
      for (const board of snapshots) {
        for (const item of board.items) {
          if (item.state === "working" && item.sessionId && !sessionOwners.has(item.sessionId))
            sessionOwners.set(item.sessionId, rootKey(board.boardRoot));
        }
      }
      const boardLoad = new Map(snapshots.map(board => [rootKey(board.boardRoot), 0]));
      for (const id of workingIds) {
        const board = sessionOwners.get(id);
        if (board && boardLoad.has(board)) boardLoad.set(board, boardLoad.get(board)! + 1);
      }
      for (const board of snapshots) {
        const pending = board.items.filter(item =>
          (item.state === "reserved" && !!item.reservationId &&
            Date.parse(item.reservationExpiresAt ?? "") > Date.now()) ||
          (item.state === "starting" && !!item.reservationId &&
            this.startingSince(board.boardRoot, item) + STARTING_HOLD_MS > Date.now()),
        ).length;
        boardLoad.set(rootKey(board.boardRoot), (boardLoad.get(rootKey(board.boardRoot)) ?? 0) + pending);
      }
      const rankingTime = Date.now();
      queued.sort((a, b) => compareQueuedCandidates(a, b, boardLoad, rankingTime));
      if (!queued.length) {
        const pending = snapshots.reduce((n, board) => n + (board.dispatchEnabled
          ? board.items.filter(item => item.state === "queued").length : 0), 0);
        this.lastIdleReason = pending
          ? `${pending} queued TaskBoard tasks are not currently executable (readiness, dependencies, or user input).`
          : "No eligible tasks are queued in enabled TaskBoard projects.";
        // Queue can be drained while unfinished workers sit idle. Maintain
        // these exact existing workers via Caffy instead of creating duplicates.
        this.scheduleWorkerWakeMaintenance(snapshots);
      }
      const nowForRetry = Date.now();
      const candidates = queued.filter(row =>
        (this.definiteFailures.get(this.retryKey(row.boardRoot, row.item))?.retryAt ?? 0) <= nowForRetry);
      if (queued.length && !candidates.length) {
        const next = Math.min(...queued.map(row =>
          this.definiteFailures.get(this.retryKey(row.boardRoot, row.item))?.retryAt ?? nowForRetry));
        this.lastIdleReason = `${queued.length} eligible queued tasks are cooling down after confirmed start failures. Automatic retry at ${new Date(next).toISOString()}.`;
        this.scheduleWorkerWakeMaintenance(snapshots);
      }
      for (const candidate of candidates.slice(0, 20)) {
        if (!this.running || !this.caffy.policyEnabled) return;
        const requestId = NodeCrypto.randomUUID();
        if (!(await this.caffy.acquireAutomaticAdmission(requestId, undefined, false, `task:${candidate.item.taskId}`))) {
          const capacity = await this.caffy.capacity().catch(() => null);
          this.lastIdleReason = this.caffy.hasPriorityCapacityMessage()
            ? "A user Queue on capacity message takes priority over TaskBoard."
            : capacity?.reason ?? "Capacity inventory unavailable; dispatch fails closed.";
          // An idle-but-unfinished task still owns a capacity lease; resume
          // that exact existing guest, never spawn another to fill its seat.
          this.scheduleWorkerWakeMaintenance(snapshots);
          return;
        }
        this.lastAdmissionAttemptAt = Date.now();
        try {
          try {
            await this.taskCommand(candidate.boardRoot, [
              "task", "queue", "reserve", candidate.item.taskId,
              "--queue-request", candidate.item.queueRequest,
              "--request-id", requestId,
              "--lease-seconds", String(RESERVATION_LEASE_SECONDS),
            ]);
          } catch (error) {
            // An uncertain CAS cannot be replayed. Reconcile exact durable
            // state before trying another candidate.
            const refreshed = await this.readQueues();
            const current = refreshed.find(board => rootKey(board.boardRoot) === rootKey(candidate.boardRoot))
              ?.items.find(item => item.taskId === candidate.item.taskId);
            if (current?.state === "queued" && current.queueRequest === candidate.item.queueRequest &&
                current.readiness && !current.claimed) {
              this.backoffDefiniteFailure(candidate.boardRoot, candidate.item,
                `Queue reservation did not succeed: ${String(error)}`);
              this.lastError = `Task ${candidate.item.taskId}: reservation could not be obtained; other eligible tasks will be tried.`;
            }
            continue;
          }
          await this.readQueues();
          this.lastIdleReason = null;
          await this.startReserved(candidate.boardRoot, candidate.item, requestId);
          return;
        } finally {
          this.caffy.releaseAutomaticAdmission(requestId);
        } // Only one new automatic worker per pump.
      }
      // Repair only a recent, definitively unsent original prompt after all
      // eligible new queued work has had admission priority. Any wake may
      // activate a worker, so never attempt it when admission is full.
      if (!this.caffy.hasPendingQueuedWakes &&
          (await this.caffy.capacity().catch(() => null))?.admissible) {
        try { await this.recoverConfirmedUnsent(snapshots); }
        catch (error) { this.lastError = `Prompt recovery: ${String(error)}`; }
      }
    } catch (error) {
      this.lastError = String(error);
      // Do not clear a Starting reservation on transport errors or timeouts.
      await this.readQueues().catch(() => []);
    } finally {
      this.busy = false;
      this.pumpStartedAt = null;
      this.lastPumpCompletedAt = Date.now();
    }
  }
}
