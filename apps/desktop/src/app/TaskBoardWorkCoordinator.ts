// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- T3 owns the dispatcher clock; TaskBoard owns reservations.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCP from "node:child_process";
import type { CaffyScheduler } from "./CaffyScheduler.ts";

interface Project { id: string; name: string; path: string }
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
interface QueueSnapshot { boardRoot: string; items: QueueItem[] }
const ROOT = process.env.T3CODE_HOME
  ? NodePath.resolve(process.env.T3CODE_HOME, "..")
  : NodePath.resolve(process.cwd(), "..", "..");
const TASKBOARD_CLI = NodePath.resolve(ROOT, "..", "TaskBoard", "packages", "task-cli", "target", "release", "taskboard.exe");
const TASKBOARD_CATALOG = () => NodePath.join(
  process.env.APPDATA ?? NodePath.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "TaskBoard", "projects.json",
);
const RESERVATION_LEASE_SECONDS = 180;
const PUMP_INTERVAL_MS = 15_000;
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

export class TaskBoardWorkCoordinator {
  private readonly caffy: CaffyScheduler;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private busy = false;
  private lastError: string | null = null;
  private lastObservedAt: string | null = null;
  private snapshots: QueueSnapshot[] = [];

  constructor(_stateDir: string, caffy: CaffyScheduler) {
    this.caffy = caffy;
  }

  private projects(): Project[] {
    let catalog: Catalog;
    try { catalog = JSON.parse(NodeFS.readFileSync(TASKBOARD_CATALOG(), "utf8")) as Catalog; }
    catch { return []; }
    if (catalog.schema !== 1 || !Array.isArray(catalog.projects)) return [];
    const hidden = new Set((catalog.hiddenPaths ?? []).map(rootKey));
    const seen = new Set<string>();
    return catalog.projects.filter(project => {
      if (!project || typeof project.path !== "string") return false;
      const key = rootKey(project.path);
      if (seen.has(key) || hidden.has(key) || !NodeFS.existsSync(NodePath.join(project.path, "_board.md")))
        return false;
      seen.add(key);
      return true;
    });
  }

  private async readQueues(): Promise<QueueSnapshot[]> {
    if (!NodeFS.existsSync(TASKBOARD_CLI)) throw new Error("Local TaskBoard CLI missing.");
    const snapshots: QueueSnapshot[] = [];
    for (const project of this.projects()) {
      try {
        const output = await cli(TASKBOARD_CLI, [
          "--json", "--root", project.path, "task", "queue", "list",
        ]) as { schema?: string; boardRoot?: string; items?: QueueItem[]; observedAt?: string };
        if (output.schema !== "taskboard-dispatch-queue/v1" ||
            rootKey(output.boardRoot ?? "") !== rootKey(project.path) ||
            !Array.isArray(output.items)) {
          throw new Error("TaskBoard returned an invalid dispatch queue snapshot.");
        }
        snapshots.push({ boardRoot: project.path, items: output.items });
        this.lastObservedAt = output.observedAt ?? new Date().toISOString();
      } catch (error) {
        this.lastError = `TaskBoard ${project.name}: ${String(error)}`;
      }
    }
    this.snapshots = snapshots;
    this.syncReservations();
    return snapshots;
  }

  private reservations(snapshots = this.snapshots): Array<{
    boardRoot: string; taskId: string; requestId: string; state: "reserved" | "starting";
    expiresAt: string | null;
  }> {
    const now = Date.now();
    return snapshots.flatMap(board => board.items.flatMap(item => {
      if ((item.state !== "reserved" && item.state !== "starting") ||
          !item.reservationId || item.legacyOpenRig) return [];
      const expiresAt = item.reservationExpiresAt ?? null;
      // An expired reservation which never entered Starting is not capacity.
      if (item.state === "reserved" && expiresAt &&
          Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now) return [];
      return [{
        boardRoot: board.boardRoot, taskId: item.taskId, requestId: item.reservationId,
        state: item.state, expiresAt,
      }];
    }));
  }

  private syncReservations() {
    this.caffy.setTaskReservations(this.reservations().length);
  }

  status() {
    const reservations = this.reservations();
    return {
      active: this.running,
      keepT3Busy: this.caffy.policyEnabled,
      observedAt: this.lastObservedAt,
      reservations,
      lastError: this.lastError,
      queued: this.snapshots.reduce((n, board) => n + board.items.filter(item =>
        item.state === "queued" && !item.legacyOpenRig).length, 0),
      legacyOpenRig: this.snapshots.reduce((n, board) => n + board.items.filter(item =>
        item.legacyOpenRig).length, 0),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.pump(); }, PUMP_INTERVAL_MS);
    this.timer.unref?.();
    // Let the session inventory and live working snapshot recover on startup.
    setTimeout(() => { void this.pump(); }, 12_000).unref?.();
  }

  close() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.caffy.setTaskReservations(0);
  }

  private async taskCommand(boardRoot: string, args: string[]) {
    return await cli(TASKBOARD_CLI, ["--json", "--root", boardRoot, ...args]);
  }

  private async startReserved(boardRoot: string, item: QueueItem, requestId: string) {
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
    const result = await cli("node.exe", [
      NodePath.join(ROOT, "scripts", "chatgpt-sessions.mjs"),
    ], JSON.stringify({
      action: "open-task",
      taskRef: { board: boardRoot, id: item.taskId },
      intent: "implement", kind: "chatgpt", background: true,
      requireQueue: true, queueRequest: item.queueRequest, reservationId: requestId,
    }), 115_000) as { status?: string; sessionId?: string; message?: string; definitelyNotCreated?: boolean };

    if (result.definitelyNotCreated === true) {
      await this.taskCommand(boardRoot, [
        "task", "queue", "failed", item.taskId,
        "--queue-request", item.queueRequest,
        "--request-id", requestId,
        "--reason", result.message ?? "T3 definitively rejected the start before creating a session",
        "--confirmed-not-created",
      ]);
      this.lastError = `Task ${item.taskId}: ${result.status ?? "start rejected"} before creation; returned to queued for a new reservation.`;
      await this.readQueues();
      return;
    }
    if (["created", "opened", "prompt_unknown"].includes(result.status ?? "")) {
      this.lastError = result.status === "prompt_unknown"
        ? `Task ${item.taskId}: session created; initial prompt delivery needs inspection.`
        : null;
      await this.readQueues();
      return;
    }
    // Unknown / in-flight outcomes stay Starting with the same reservation ID.
    // The next pump calls open-task again; its journal performs read-only
    // reconciliation by the original T3 spawn request ID before any new send.
    this.lastError = `Task ${item.taskId}: ${result.status ?? "unknown"}; retaining the same Starting reservation.`;
  }

  async pump() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const snapshots = await this.readQueues();
      if (!this.running) return;

      // Recover a durable Starting request even when admission is paused. It
      // may already have created a worker, so its exact request must reconcile.
      const starting = snapshots.flatMap(board => board.items
        .filter(item => item.state === "starting" && item.reservationId && !item.legacyOpenRig)
        .map(item => ({ boardRoot: board.boardRoot, item })));
      if (starting.length) {
        const next = starting[0]!;
        this.syncReservations();
        await this.starting(next.item, next.boardRoot, next.item.reservationId!);
        return;
      }
      // Keep queue state/capacity visible while paused, but do not begin a task
      // whose durable reservation has not reached Starting.
      if (!this.caffy.policyEnabled) return;

      // Resume an unexpired Reserved task, or replace an expired lease.
      const reserved = snapshots.flatMap(board => board.items
        .filter(item => item.state === "reserved" && item.reservationId && !item.legacyOpenRig)
        .map(item => ({ boardRoot: board.boardRoot, item })));
      if (reserved.length) {
        const next = reserved[0]!;
        const expiry = Date.parse(next.item.reservationExpiresAt ?? "");
        const liveLease = Number.isFinite(expiry) && expiry > Date.now();
        if (liveLease) {
          this.syncReservations();
          await this.startReserved(next.boardRoot, next.item, next.item.reservationId!);
          return;
        }
        // The previous lease never reached Starting, so no spawn was authorized.
        // A fresh CAS reservation is safe and replaces the expired request ID.
        const capacity = await this.caffy.capacity().catch(() => ({ admissible: false }));
        if (!capacity.admissible) return;
        const requestId = NodeCrypto.randomUUID();
        await this.taskCommand(next.boardRoot, [
          "task", "queue", "reserve", next.item.taskId,
          "--queue-request", next.item.queueRequest,
          "--request-id", requestId,
          "--lease-seconds", String(RESERVATION_LEASE_SECONDS),
        ]);
        await this.startReserved(next.boardRoot, next.item, requestId);
        return;
      }

      const queued = snapshots.flatMap(board => board.items
        .filter(item => item.state === "queued" && item.readiness && !item.claimed &&
          !item.legacyOpenRig && UUID.test(item.queueRequest))
        .map(item => ({ boardRoot: board.boardRoot, item })));
      queued.sort((a, b) =>
        (a.item.priority === "urgent" ? 0 : 1) - (b.item.priority === "urgent" ? 0 : 1) ||
        a.item.created.localeCompare(b.item.created) ||
        a.boardRoot.localeCompare(b.boardRoot) || a.item.taskId.localeCompare(b.item.taskId));
      for (const candidate of queued.slice(0, 20)) {
        if (!this.running || !this.caffy.policyEnabled) return;
        const capacity = await this.caffy.capacity().catch(() => ({ admissible: false }));
        if (!capacity.admissible) return;
        const requestId = NodeCrypto.randomUUID();
        try {
          await this.taskCommand(candidate.boardRoot, [
            "task", "queue", "reserve", candidate.item.taskId,
            "--queue-request", candidate.item.queueRequest,
            "--request-id", requestId,
            "--lease-seconds", String(RESERVATION_LEASE_SECONDS),
          ]);
        } catch {
          // Another coordinator may have reserved it first. Refresh the canonical
          // board instead of guessing whether this request won the compare-and-set.
          await this.readQueues();
          continue;
        }
        this.syncReservations();
        await this.startReserved(candidate.boardRoot, candidate.item, requestId);
        return; // One selection at a time; capacity is sampled again next pump.
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error);
      // Do not clear a Starting reservation on transport errors or timeouts.
      await this.readQueues().catch(() => []);
    } finally {
      this.busy = false;
    }
  }
}
