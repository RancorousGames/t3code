// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Desktop-owned local TaskBoard CLI boundary.
// Starts only human-queued TaskBoard tasks and only while Keep T3 Busy permits.
// The TaskBoard CLI owns eligibility/claims; open-task's per-task request journal
// owns duplicate prevention across crashes or lost acknowledgements.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCP from "node:child_process";
import type { CaffyScheduler } from "./CaffyScheduler.ts";

interface Project { id: string; name: string; path: string }
interface Catalog { schema: 1; projects: Project[]; hiddenPaths?: string[] }
interface WorkTask {
  id: string; title: string; path: string;
  column: string; kind: string; claimed_by?: string | null;
  archived: boolean; completed?: string | null; blocked_reason?: string | null;
  review_status?: string | null; attention?: string[];
  question?: {answer?: string | null} | null; depends_on?: string[];
  created?: string;
}
interface Reservation {
  boardRoot: string; taskId: string; queueRequest: string; startedAt: number;
  sessionId: string | null; outcome: string;
}
interface Stored { version: 1; reservations: Reservation[]; lastError: string | null }
const ROOT = "D:/SSDProjects/Tools/t3code";
const TASKBOARD_CLI = "D:/SSDProjects/Tools/TaskBoard/packages/task-cli/target/release/taskboard.exe";
const TASKBOARD_CATALOG = () => NodePath.join(
  process.env.APPDATA ?? NodePath.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "TaskBoard", "projects.json",
);
const START_RESERVATION_MS = 3 * 60_000;
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
      reject(new Error("T3 TaskBoard CLI timeout; outcome UNKNOWN, reconcile prior request."));
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
        reject(new Error(`TaskBoard CLI exited ${String(code)}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as unknown); }
      catch { reject(new Error("TaskBoard CLI receipt unreadable; reconcile before retry.")); }
    });
    child.stdin.end(stdin);
  });
}

function readYaml(file: string): Record<string, string> {
  try {
    const text = NodeFS.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (!text.startsWith("---")) return {};
    const end = text.indexOf("\n---", 4);
    if (end < 0) return {};
    const header = text.slice(4, end);
    const result: Record<string, string> = {};
    for (const line of header.split(/\r?\n/)) {
      const match = /^([a-z_]+):\s*(.*)\s*$/.exec(line);
      if (match?.[1] && match[2] !== undefined)
        result[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
    return result;
  } catch { return {}; }
}
const rootKey = (value: string) => NodePath.resolve(value).toLowerCase();

export class TaskBoardWorkCoordinator {
  private readonly file: string;
  private reservations: Reservation[] = [];
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private busy = false;
  private readonly caffy: CaffyScheduler;

  constructor(stateDir: string, caffy: CaffyScheduler) {
    this.caffy = caffy;
    NodeFS.mkdirSync(stateDir, { recursive: true });
    this.file = NodePath.join(stateDir, "t3-taskboard-work-coordinator-v1.json");
    try {
      const store = JSON.parse(NodeFS.readFileSync(this.file, "utf8")) as Stored;
      if (store.version === 1 && Array.isArray(store.reservations)) {
        this.reservations = store.reservations.filter(row =>
          typeof row.boardRoot === "string" && typeof row.taskId === "string" &&
          Number.isFinite(row.startedAt) &&
          row.startedAt >= Date.now() - START_RESERVATION_MS &&
          row.startedAt <= Date.now() + 60_000);
        this.lastError = store.lastError;
      }
    } catch { /* missing file is ordinary startup */ }
    this.syncReservations();
  }

  private syncReservations() {
    const now = Date.now();
    this.reservations = this.reservations.filter(row =>
      now >= row.startedAt && now - row.startedAt < START_RESERVATION_MS);
    this.caffy.setTaskReservations(this.reservations.length);
  }
  private save() {
    this.syncReservations();
    const tmp = this.file + "." + process.pid + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify({
        version: 1, reservations: this.reservations, lastError: this.lastError,
      } satisfies Stored), { encoding: "utf8", flush: true });
      NodeFS.renameSync(tmp, this.file);
    } finally {
      NodeFS.rmSync(tmp, {force: true});
    }
  }
  status() {
    this.syncReservations();
    return {
      reservations: this.reservations, lastError: this.lastError,
      active: this.running, keepT3Busy: this.caffy.policyEnabled,
    };
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.pump(); }, 60_000);
    this.timer.unref?.();
    // Give the session registry time to recover before reading capacity.
    setTimeout(() => { void this.pump(); }, 12_000).unref?.();
  }
  close() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.caffy.setTaskReservations(0);
  }

  private projects(): Project[] {
    let catalog: Catalog;
    try {
      catalog = JSON.parse(NodeFS.readFileSync(TASKBOARD_CATALOG(), "utf8")) as Catalog;
    } catch { return []; }
    if (catalog.schema !== 1 || !Array.isArray(catalog.projects)) return [];
    const hidden = new Set((catalog.hiddenPaths ?? []).map(rootKey));
    const seen = new Set<string>();
    return catalog.projects.filter(project => {
      if (!project || typeof project.path !== "string") return false;
      const key = rootKey(project.path);
      if (seen.has(key) || hidden.has(key) ||
          !NodeFS.existsSync(NodePath.join(project.path, "_board.md"))) return false;
      seen.add(key);
      return true;
    });
  }

  private async next(): Promise<{boardRoot: string; taskId: string; queueRequest: string} | null> {
    if (!NodeFS.existsSync(TASKBOARD_CLI)) {
      this.lastError = "Local TaskBoard CLI missing.";
      return null;
    }
    const candidates: { boardRoot: string; taskId: string; queueRequest: string; priority: number; created: string }[] = [];
    for (const project of this.projects()) {
      try {
        const output = await cli(TASKBOARD_CLI,
          ["task", "list", "--json", "--root", project.path]);
        if (!output || typeof output !== "object" || !("tasks" in output) ||
            !Array.isArray(output.tasks)) continue;
        const tasks = output.tasks as WorkTask[];
        const byId = new Map(tasks.map(task => [task.id, task]));
        for (const task of tasks) {
          if (!task?.id || !task.path || !/^[A-Za-z][A-Za-z0-9]*-[0-9]{4,}$/.test(task.id) ||
              !["task", "recurring"].includes(task.kind) || task.column !== "ai-ready" ||
              task.archived || task.completed || task.claimed_by || task.blocked_reason ||
              task.review_status === "open" ||
              task.attention?.some(flag => ["blocked", "needs-user", "question"].includes(flag)) ||
              (task.question && !task.question.answer) ||
              task.depends_on?.some(dependency => {
                const dep = byId.get(dependency);
                // Missing dependencies are never evidence of completion; only
                // an explicit terminal row from the full board can authorize.
                return !dep || !dep.completed;
              })) continue;
          // TaskBoard source is the authority. Never dispatch a legacy OpenRig
          // registration/UNKNOWN attempt in parallel with its original owner.
          const meta = readYaml(task.path);
          if (meta.execution_mode !== "queue" || !UUID.test(meta.queue_request ?? "") ||
              meta.queue_registration_attempt || meta.queue_attempt || meta.queue_receipt ||
              meta.queue_retired_receipt || meta.start_now_request) continue;
          if (this.reservations.some(row =>
              row.taskId === task.id && rootKey(row.boardRoot) === rootKey(project.path))) continue;
          candidates.push({
            boardRoot: project.path, taskId: task.id, queueRequest: meta.queue_request,
            priority: task.attention?.includes("priority") ? 0 : 1,
            created: task.created ?? "9999",
          });
        }
      } catch (error) {
        this.lastError = `TaskBoard ${project.name}: ${String(error)}`;
      }
    }
    candidates.sort((a,b) => a.priority - b.priority ||
      a.created.localeCompare(b.created) ||
      a.boardRoot.localeCompare(b.boardRoot) ||
      a.taskId.localeCompare(b.taskId));
    for (const candidate of candidates.slice(0, 20)) {
      // Readiness and queue-intent are rechecked by the TaskBoard authority;
      // do not trust partial frontmatter filtering as an admission grant.
      try {
        const shown = await cli(TASKBOARD_CLI,
          ["task", "show", candidate.taskId, "--json", "--root", candidate.boardRoot]) as {
            readiness?: string; task?: WorkTask;
          };
        if (shown.readiness !== "ready" || shown.task?.claimed_by ||
            shown.task?.column !== "ai-ready") continue;
        const intent = await cli(TASKBOARD_CLI,
          ["task", "execution", candidate.taskId, "show", "--root", candidate.boardRoot]) as {
            mode?: string; queue_request?: string;
            queue_attempt?: string | null; queue_receipt?: string | null;
          };
        if (intent.mode !== "queue" || intent.queue_request !== candidate.queueRequest ||
            intent.queue_attempt || intent.queue_receipt) continue;
        return candidate;
      } catch (error) {
        this.lastError = `TaskBoard eligibility: ${String(error)}`;
      }
    }
    return null;
  }

  async pump() {
    if (!this.running || this.busy || !this.caffy.policyEnabled) return;
    this.busy = true;
    let dispatched = false;
    try {
      this.syncReservations();
      if (!(await this.caffy.capacity().catch(() => ({admissible:false}))).admissible) return;
      const selected = await this.next();
      if (!selected || !this.caffy.policyEnabled) return;
      if (!this.caffy.policyEnabled ||
          !(await this.caffy.capacity().catch(() => ({admissible:false}))).admissible) return;
      const row: Reservation = {
        ...selected, sessionId: null, startedAt: Date.now(), outcome: "starting",
      };
      this.reservations.push(row);
      this.save(); // Capacity reserved before requesting any spawn.
      dispatched = true;
      try {
        const result = await cli("node.exe", [NodePath.join(ROOT, "scripts", "chatgpt-sessions.mjs")],
          JSON.stringify({
            action: "open-task", taskRef: { board: selected.boardRoot, id: selected.taskId },
            intent: "implement", kind: "chatgpt", background: true,
            requireQueue: true, queueRequest: selected.queueRequest,
          }), 115_000) as { status?: string; sessionId?: string };
        row.outcome = result.status ?? "unknown";
        row.sessionId = typeof result.sessionId === "string" ? result.sessionId : null;
        if (!["created", "opened", "prompt_unknown"].includes(row.outcome))
          this.lastError = `Task ${selected.taskId}: ${row.outcome}. Original request retained for reconciliation.`;
        else this.lastError = null;
      } catch (error) {
        row.outcome = "unknown";
        this.lastError = `Task ${selected.taskId}: ${String(error)}. Original request retained; no duplicate spawn.`;
      }
      this.save();
    } finally {
      this.busy = false;
      // Fill additional verified slots promptly, but every attempt reserves
      // capacity first and uses the same durable task-open identity.
      if (dispatched && this.running && this.caffy.policyEnabled &&
          this.reservations.length < 100) {
        setTimeout(() => { void this.pump(); }, 12_000).unref?.();
      }
    }
  }
}
