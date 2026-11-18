// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- T3 owns local durable timers and power requests.
// T3-owned Caffy. No OpenRig or OmniHub scheduler dependency.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type {
  CapacityMessageReceipt, CapacityMessageRequest,
  DesktopAppActivationRequest, DesktopAppActivationResponse,
} from "@t3tools/contracts";
import type { ChatGPTDeliveryQueue, DeliveryRecord } from "./ChatGPTDeliveryQueue.ts";
import type { VerifiedChatGPTIdleTransition } from "./ChatGPTIdleTransitionJournal.ts";
import { AutoworkThroughput } from "./AutoworkThroughput.ts";
import { AutomaticAdmissionJournal } from "./AutomaticAdmissionJournal.ts";
import { caffyWakePhase, reduceCaffyWake } from "./CaffyWakeMachine.ts";

/** "idle" = Keep running (wake on every idle), "periodic" = Interval wake. */
type Mode = "idle" | "periodic" | "startup";
type Trigger = "idle" | "periodic" | "startup" | "manual";
type Request = (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
export interface CaffyConfig {
  /** Native T3 threads have no ChatGPT conversation or browser guest. */
  targetKind?: "t3";
  environmentId?: string;
  nativeThreadId?: string;
  nativeLastRunOrdinal?: number;
  nativeLastSendAttemptAt?: number | null;
  sessionId: string;
  browserSessionId?: string | undefined;
  /** Public Bootstrap / T3_ID alias; never use as the delivery target unless it is the browser ID. */
  publicSessionId?: string | undefined;
  conversationId: string;
  mode: Mode;
  /** Wait for a free Keep T3 Busy working slot before waking. Default: ignore slots. */
  respectSlots: boolean;
  intervalMinutes: number;
  startup: boolean;
  onceOnly: boolean;
  keepAwake: boolean;
  paused: boolean;
  createdAt: number;
  expiresAt: number | null;
  nextDueAt: number | null;
  pendingWake: boolean;
  pendingReason: Trigger | null;
  pendingMessageId: string | null;
  lastIdleSequence: number;
  /** Last answered ChatGPT user turn handled by idle mode; survives restarts. */
  lastHandledIdleTurnCount?: number;
  /** Durable idle event claim. Unlike DOM turnCount, this is an event receipt. */
  lastHandledIdleEventId?: string | null;
  lastIdleEvidenceKey?: string | null;
  transitionVersion?: number;
  availability?: "ready" | "working" | "unmounted" | "recovering" | "unavailable";
  admissionReason?: string | null;
  deliveryUpdatedAt?: number | null;
  deliveryAwaitingGuest?: boolean;
  bindingObservedAt?: number | null;
  lastWakeAt: number | null;
  lastError: string | null;
  /** Last scheduler observation of this T3 session, regardless of wake eligibility. */
  lastCheckedAt?: number | null;
  /** Why the scheduler did or did not request a continuation at that check. */
  lastCheckResult?: string | null;
  nextCheckAt?: number | null;
  wakePhase?: ReturnType<typeof caffyWakePhase>;
  deliveryStatus?: DeliveryRecord["status"] | null;
  lastDeliveryResult?: string | null;
  /** Absolute future start, persisted through full desktop restarts. */
  beginAt?: number | null;
  /** Optional one-time instruction for the next delayed wake. */
  delayedPrompt?: string | null;
  /** Instruction repeated on every automatic continuation. */
  repeatPrompt?: string | null;
  /** Pinned with pendingMessageId so crash recovery cannot change a queued send. */
  pendingMessageBody?: string | null;
  /** Reboot only before the next due continuation. */
  autoRebootMinutes?: number | null;
  autoRebootEveryRuns?: number | null;
  wakesSinceReboot?: number;
  lastCountedWakeAt?: number | null;
  /** First verified working observation or completed Caffy wake. */
  lastActivatedAt?: number | null;
  lastRebootAt?: number | null;
  /** Durable reboot operation ID; never allocate a second if outcome is UNKNOWN. */
  rebootOperationId?: string | null;
  rebootOldConversationId?: string | null;
}
export interface AgentStoppedCaffy {
  sessionId: string;
  browserSessionId?: string | undefined;
  publicSessionId?: string | undefined;
  stoppedAt: number;
}
interface LocalCapacityClaim {
  messageId: string; sessionId: string; conversationId: string | null;
  state: "waiting" | "admitted" | "submitted" | "uncertain";
  createdAt: number; submittedAt: number | null;
}
export interface ScheduledSpawnCaffy {
  mode: "idle" | "periodic";
  intervalMinutes: number;
  respectSlots: boolean;
  durationMinutes?: number | undefined;
  repeatPrompt?: string | undefined;
  autoRebootMinutes?: number | null | undefined;
  autoRebootEveryRuns?: number | null | undefined;
}
interface ScheduledChatGPTSpawn {
  id: string;
  title: string;
  prompt: string;
  beginAt: number | null;
  /** Wait for Keep T3 Busy to have a free agent slot, ahead of TaskBoard. */
  onIdle?: boolean;
  project?: string;
  /** Optional Caffy continuation to attach after the new session has a verified conversation. */
  caffy?: ScheduledSpawnCaffy | null;
  caffyAppliedAt?: number;
  caffyError?: string;
  status: "scheduled" | "dispatching" | "created" | "uncertain";
  /** Short reservation while the newly spawned session mounts and starts. */
  holdUntil?: number;
  sessionId?: string;
  error?: string;
}
interface CaffyRosterEntry {
  id?: string; browserSessionId?: string; publicSessionId?: string;
  conversationId?: string;
  bootstrapIdentity?: { state?: string; publicId?: string; conversationId?: string };
  lastIdleTransition?: { eventId?: string; conversationId?: string; sequence?: number };
  activity?: string; status?: string; lastRole?: string; statusObservedAt?: string;
  hidden?: boolean; snoozedUntil?: number; closedAt?: unknown;
}
interface CaffyRoster {
  sessions: CaffyRosterEntry[]; total?: number; hasMore?: boolean; incomplete?: boolean;
}

/** Ownership is resolved only by T3 IDs. Undefined aliases never match. */
function matchesCaffyOwner(entry: CaffyRosterEntry, ids: readonly (string | undefined)[]) {
  const wanted = new Set(ids.filter((id): id is string => !!id));
  return [entry.id, entry.browserSessionId, entry.publicSessionId,
    entry.bootstrapIdentity?.publicId, entry.lastIdleTransition?.eventId?.split(":")[0]]
    .some(id => !!id && wanted.has(id));
}

interface CaffyStore {
  version: 2;
  entries: CaffyConfig[];
  scheduledSpawns?: ScheduledChatGPTSpawn[];
  capacityClaims?: LocalCapacityClaim[];
  keepT3Busy: boolean;
  maxWorking: number;
  shutdownWhenIdle?: boolean;
  busyUntil?: number | null;
  agentStops?: AgentStoppedCaffy[];
  terminalConversations?: Array<{ sessionId: string; conversationId: string }>;
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LEGACY_TERMINAL_STATES = new Set([
  "cancelled", "canceled", "completed", "exhausted", "mandate_finished",
  "blocked", "expired", "failed",
]);

/** A legacy monitor remains a separate scheduler owner until its state is terminal. */
export function legacyMonitorOwnsConversation(
  monitor: { state?: string; target?: { sessionId?: string; expectedConversationId?: string } },
  sessionId: string, conversationId: string,
): boolean {
  return !LEGACY_TERMINAL_STATES.has(monitor.state ?? "") &&
    (monitor.target?.sessionId === sessionId ||
      monitor.target?.expectedConversationId === conversationId);
}
const WAKE_TEXT = "Continue working on your current assignment. If everything is genuinely finished, stop Caffy for this session using the caffy tool (action=stop, sessionId=your T3_ID).";
const CLOCK = 20_000;
const nativeOwner = (environmentId: string, threadId: string) => `t3:${environmentId}:${threadId}`;
const valid = (row: CaffyConfig): boolean =>
  !!row && (row.targetKind === "t3"
    ? !!row.environmentId && !!row.nativeThreadId &&
      row.sessionId === nativeOwner(row.environmentId, row.nativeThreadId) &&
      row.conversationId === row.nativeThreadId
    : UUID.test(row.sessionId) && UUID.test(row.conversationId)) &&
  ["idle", "periodic", "startup"].includes(row.mode) &&
  Number.isFinite(row.createdAt) && Number.isInteger(row.intervalMinutes) &&
  row.intervalMinutes >= 1 && row.intervalMinutes <= 525_600 &&
  (row.expiresAt === null || Number.isFinite(row.expiresAt)) &&
  (row.pendingMessageId === null || UUID.test(row.pendingMessageId));

/** One persistent policy and one pending message per session, regardless of wake source. */
export class CaffyScheduler {
  private readonly file: string;
  readonly throughput: AutoworkThroughput;
  private readonly automaticAdmissionJournal: AutomaticAdmissionJournal;
  private readonly entries = new Map<string, CaffyConfig>();
  private readonly scheduledSpawns = new Map<string, ScheduledChatGPTSpawn>();
  private readonly agentStops = new Map<string, AgentStoppedCaffy>();
  private readonly terminalConversations = new Map<string, string>();
  private keepT3Busy = false;
  private maxWorking = 6;
  private shutdownWhenIdle = false;
  private busyUntil: number | null = null;
  private shutdownIdleSince: number | null = null;
  private shutdownChecking = false;
  private shutdownError: string | null = null;
  private readonly shutdownPC: () => void;
  private readonly workingReports = new Map<string, { observedAt: number; ids: Set<string> }>();
  private nativeCapacityCache: { observedAt: number; ids: string[]; known: boolean } | null = null;
  private readonly automaticAdmissions = new Set<string>();
  private readonly capacityClaims = new Map<string, LocalCapacityClaim>();
  private admissionGate: Promise<void> = Promise.resolve();
  private taskReservations: Array<{requestId: string; sessionId: string | null; holdUntil?: number}> = [];
  private taskBoardInventoryReady = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatSubscribers = new Set<() => void>();
  private pumping = false;
  private pumpRequested = false;
  private lastIdentityReconcileAt = 0;
  private identityReconciliation: Promise<void> | null = null;
  private blockerId: number | null = null;
  private readonly deliveries: ChatGPTDeliveryQueue;
  private readonly request: Request;
  private latestIdle: (sessionId: string) => VerifiedChatGPTIdleTransition | null = () => null;
  private readonly power: { start: () => number; stop: (id: number) => void };

  constructor(
    stateDir: string,
    deliveries: ChatGPTDeliveryQueue,
    request: Request,
    power: { start: () => number; stop: (id: number) => void },
    shutdownPC: () => void = () => {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Desktop main shutdown is Windows-only; tests inject this callback.
      if (process.platform !== "win32")
        throw new Error("Forced shutdown supported only on Windows.");
      // /f forcibly closes unsaved apps; /t 0 requests immediate poweroff.
      const result = NodeChildProcess.spawnSync("shutdown.exe", ["/s", "/f", "/t", "0"], {
        windowsHide: true, encoding: "utf8", timeout: 5_000,
      });
      if (result.error || result.status !== 0)
        throw new Error(`Shutdown request refused: ${result.error?.message ?? result.stderr ?? result.status}`);
    },
  ) {
    this.shutdownPC = shutdownPC;
    this.deliveries = deliveries;
    this.request = request;
    this.power = power;
    NodeFS.mkdirSync(stateDir, { recursive: true });
    this.file = NodePath.join(stateDir, "caffy-v2.json");
    this.automaticAdmissionJournal = new AutomaticAdmissionJournal(stateDir);
    try {
      const saved = JSON.parse(NodeFS.readFileSync(this.file, "utf8")) as CaffyStore;
      if (saved.version === 2 && Array.isArray(saved.entries)) {
        for (const row of saved.entries) {
          // Older stores: "queued" was Keep running that respected slots. All
          // rows now default to ignoring slots unless explicitly set.
          if ((row.mode as string) === "queued") row.mode = "idle";
          row.respectSlots = row.respectSlots === true;
          delete (row as { capacityHeld?: unknown }).capacityHeld;
          delete (row as { runWithoutBusy?: unknown }).runWithoutBusy;
          if (!valid(row)) continue;
          // An interval with no deadline and no wake in flight restarts now.
          if (row.mode === "periodic" && !Number.isFinite(row.nextDueAt) &&
              !row.pendingWake && !row.pendingMessageId)
            row.nextDueAt = Date.now() + row.intervalMinutes * 60_000;
          if (row.mode !== "periodic") row.nextDueAt = null;
          this.entries.set(row.sessionId, row);
        }
        for (const job of saved.scheduledSpawns ?? []) {
          if (!job || !UUID.test(job.id) ||
              !(job.onIdle === true ? job.beginAt === null : Number.isSafeInteger(job.beginAt)) ||
              typeof job.title !== "string" || typeof job.prompt !== "string" ||
              !["scheduled", "dispatching", "created", "uncertain"].includes(job.status)) continue;
          // Dispatch may have reached the renderer before T3 shut down.
          if (job.status === "dispatching") {
            job.status = "uncertain";
            job.error = "T3 restarted during creation. Inspect this request before retrying.";
          }
          this.scheduledSpawns.set(job.id, job);
        }
        for (const claim of saved.capacityClaims ?? []) {
          if (claim && UUID.test(claim.messageId) && UUID.test(claim.sessionId) &&
              (claim.conversationId === null || UUID.test(claim.conversationId)) &&
              ["waiting", "admitted", "submitted", "uncertain"].includes(claim.state) &&
              Number.isFinite(claim.createdAt))
            this.capacityClaims.set(claim.messageId, claim);
        }
        for (const terminal of saved.terminalConversations ?? []) {
          if (UUID.test(terminal.sessionId) && UUID.test(terminal.conversationId))
            this.terminalConversations.set(terminal.sessionId, terminal.conversationId);
        }
        for (const [id, row] of this.entries) {
          if (this.terminalConversations.get(id) === row.conversationId)
            this.entries.delete(id);
        }
        for (const mark of saved.agentStops ?? []) {
          if (mark && UUID.test(mark.sessionId) && Number.isFinite(mark.stoppedAt) &&
              Date.now() - mark.stoppedAt < 7 * 24 * 60 * 60_000)
            this.agentStops.set(mark.sessionId, mark);
        }
        this.keepT3Busy = saved.keepT3Busy === true;
        this.shutdownWhenIdle = saved.shutdownWhenIdle === true;
        this.busyUntil = saved.busyUntil != null && Number.isSafeInteger(saved.busyUntil) && saved.busyUntil > 0
          ? saved.busyUntil : null;
        if (Number.isInteger(saved.maxWorking) && saved.maxWorking >= 1 && saved.maxWorking <= 100)
          this.maxWorking = saved.maxWorking;
      }
    } catch { /* Corrupt/missing local state is not evidence for a wake. */ }
    this.throughput = new AutoworkThroughput(stateDir,
      this.keepT3Busy && (this.busyUntil === null || this.busyUntil > Date.now()));
    this.deliveries.subscribeTransitions(record => this.onDelivery(record));
    this.deliveries.setDispatchPermission(record => {
      const row = this.lookup(record.sessionId);
      // Pausing a schedule also holds its pending wake (it gives up after an hour).
      return !row || row.pendingMessageId !== record.messageId || !row.paused;
    });
    this.deliveries.setDispatchAdmission(async record => {
      const row = this.lookup(record.sessionId);
      if (!row || row.pendingMessageId !== record.messageId) return true;
      const state = this.deliveries.status(record.messageId).status;
      if (state === "uncertain" || state === "sending") return true;
      if (row.paused) return false;
      if (!row.respectSlots) return true;
      const snapshot = await this.capacity().catch(() => null);
      // An already admitted wake may finish its exact pending send, but a
      // preexisting oversubscription must not authorize additional Caffy
      // activations. TaskBoard and Caffy use the same global cap.
      return snapshot?.unknown === 0 &&
        snapshot.used + snapshot.reserved <= snapshot.limit;
    });
  }

  /** The main process supplies the same durable journal used to dispatch live idle events. */
  setLatestIdleSource(source: (sessionId: string) => VerifiedChatGPTIdleTransition | null) {
    this.latestIdle = source;
  }

  /** Retain recent durable configuration snapshots so a bad lifecycle
   * reconciliation or forced restart cannot destroy the only recoverable copy.
   * Snapshots are forensic backups, never silently restored after Stop Caffy.
   */
  private backupConfiguration() {
    if (this.entries.size === 0) return;
    try {
      const directory = NodePath.join(NodePath.dirname(this.file), "caffy-snapshots");
      NodeFS.mkdirSync(directory, { recursive: true });
      const filename = `caffy-${new Date().toISOString().replace(/[:.]/g, "-")}-${NodeCrypto.randomUUID()}.json`;
      NodeFS.copyFileSync(this.file, NodePath.join(directory, filename));
      const snapshots = NodeFS.readdirSync(directory)
        .filter(name => /^caffy-.*\.json$/.test(name)).sort();
      for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - 12)))
        NodeFS.rmSync(NodePath.join(directory, stale), { force: true });
    } catch { /* Snapshot failure must not prevent live Caffy operations. */ }
  }

  /** Log every pause/resume transition, especially implicit resumes from reconfiguration. */
  private logPauseChange(row: CaffyConfig, wasPaused: boolean, cause: string, requestId?: string) {
    if (wasPaused === row.paused) return;
    try {
      NodeFS.appendFileSync(NodePath.join(NodePath.dirname(this.file), "caffy-state-transitions.ndjson"),
        JSON.stringify({
          at: new Date().toISOString(),
          event: row.paused ? "paused" : "resumed",
          cause,
          requestId: requestId ?? null, // Desktop IPC correlation; null for internal scheduling.
          sessionId: row.sessionId,
          publicSessionId: row.publicSessionId ?? null,
          conversationId: row.conversationId,
          mode: row.mode,
          intervalMinutes: row.intervalMinutes,
        }) + "\n");
    } catch { /* Audit failures must not stop Caffy. */ }
  }

  private save() {
    const tmp = this.file + "." + process.pid + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify({
        version: 2, entries: [...this.entries.values()],
        scheduledSpawns: [...this.scheduledSpawns.values()],
        capacityClaims: [...this.capacityClaims.values()],
        agentStops: [...this.agentStops.values()].slice(-128),
        terminalConversations: [...this.terminalConversations].map(([sessionId, conversationId]) => ({ sessionId, conversationId })),
        keepT3Busy: this.keepT3Busy, maxWorking: this.maxWorking,
        shutdownWhenIdle: this.shutdownWhenIdle,
        busyUntil: this.busyUntil,
      } satisfies CaffyStore), { encoding: "utf8", flush: true });
      NodeFS.renameSync(tmp, this.file);
    } finally {
      if (NodeFS.existsSync(tmp)) NodeFS.rmSync(tmp, { force: true });
    }
    this.syncPower();
  }

  /** Existing OmniHub monitors remain owned by their old scheduler until
   * a verified cancellation/transfer. Never silently start a parallel wake. */
  private legacyConflict(sessionId: string, conversationId: string): boolean {
    const root = process.env.LOCALAPPDATA;
    if (!root) return false;
    try {
      const store = JSON.parse(NodeFS.readFileSync(
        NodePath.join(root, "OmniHub", "temporary-keep-awake-v1.json"), "utf8",
      )) as {monitors?: Record<string, {state?: string; target?: {
        sessionId?: string; expectedConversationId?: string;
      }}>};
      return Object.values(store.monitors ?? {}).some(monitor =>
        legacyMonitorOwnsConversation(monitor, sessionId, conversationId));
    } catch { return false; }
  }

  private syncPower() {
    const active = [...this.entries.values()].some(row => !row.paused && row.keepAwake &&
      (row.expiresAt === null || row.expiresAt > Date.now()));
    if (active && this.blockerId === null) {
      try { this.blockerId = this.power.start(); } catch { /* never prevent scheduler progress */ }
    } else if (!active && this.blockerId !== null) {
      try { this.power.stop(this.blockerId); } finally { this.blockerId = null; }
    }
  }

  subscribeHeartbeat(callback: () => void): () => void {
    this.heartbeatSubscribers.add(callback);
    return () => { this.heartbeatSubscribers.delete(callback); };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.expireTimedBusy();
    this.backupConfiguration();
    let changed = false;
    for (const row of this.entries.values()) {
      if (row.targetKind !== "t3" && this.legacyConflict(row.sessionId, row.conversationId)) {
        row.paused = true;
        row.lastError = "A legacy OmniHub wake still owns this session; cancel/reconcile it before enabling T3 Caffy.";
        changed = true;
      }
      if (row.startup && !row.paused && !row.pendingMessageId &&
          (row.expiresAt === null || row.expiresAt > Date.now())) {
        row.pendingWake = true;
        row.pendingReason = "startup";
        changed = true;
      }
      // Upgrade never-woken resume-on-idle monitors created by older builds
      // with wakeNow=false. Requeue once on startup, even without a new idle
      // transition; the guarded outbox will wait until sending is safe.
      if (row.mode === "idle" && !row.onceOnly && !row.paused &&
          !row.pendingWake && !row.pendingMessageId && row.lastWakeAt === null &&
          (row.beginAt === null || row.beginAt === undefined || row.beginAt <= Date.now()) &&
          (row.expiresAt === null || row.expiresAt > Date.now())) {
        row.pendingWake = true;
        row.pendingReason = "manual";
        changed = true;
      }
    }
    if (changed) this.save();
    this.syncPower();
    this.timer = setInterval(() => {
      this.expireTimedBusy();
      this.throughput.heartbeat();
      void this.pump();
      void this.checkShutdown();
      for (const callback of this.heartbeatSubscribers) callback();
    }, CLOCK);
    this.timer.unref?.();
    void this.pump();
  }

  close() {
    this.throughput.setEnabled(false);
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.workingReports.clear();
    this.shutdownIdleSince = null;
    if (this.blockerId !== null) {
      try { this.power.stop(this.blockerId); } finally { this.blockerId = null; }
    }
  }

  private lookup(sessionId: string): CaffyConfig | undefined {
    return this.entries.get(sessionId) ??
      [...this.entries.values()].find(row =>
        row.browserSessionId === sessionId || row.publicSessionId === sessionId ||
        (row.targetKind === "t3" && row.nativeThreadId === sessionId));
  }

  /** Resolve public Bootstrap aliases to the durable browser owner, never by conversation ID. */
  async reconcileIdentityAliases(force = false): Promise<void> {
    if (this.identityReconciliation) return this.identityReconciliation;
    this.identityReconciliation = this.reconcileOwners(force);
    try { await this.identityReconciliation; }
    finally { this.identityReconciliation = null; }
  }

  private async reconcileOwners(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastIdentityReconcileAt < 30_000) return;
    this.lastIdentityReconcileAt = now;
    const roster = await this.loadRoster().catch(() => null);
    // Resolve the durable T3 owner first. A changed ChatGPT conversation is a
    // binding migration, not a Caffy stop/recreate or a new monitor.
    if (roster) await this.reconcileLifecycle(roster);
    let changed = false;
    // oxlint-disable-next-line unicorn/no-useless-spread -- Snapshot keys before lifecycle migration mutates this map.
    for (const row of [...this.entries.values()]) {
      if (row.targetKind === "t3") continue; // Native activity uses t3.threads, never the browser roster.
      const checked = (reason: string) => {
        row.lastCheckedAt = Date.now();
        row.nextCheckAt = row.lastCheckedAt + 30_000;
        row.lastCheckResult = reason;
        changed = true;
      };
      if (row.rebootOperationId) {
        checked("Reboot in progress; retaining the T3 session policy and delivery guard.");
        await this.reconcileReboot(row).catch(() => {});
        continue;
      }
      const binding = roster
        ? this.bindingInRoster(roster, row.sessionId, row.conversationId)
        : null;
      if (!binding) {
        row.availability = "unavailable";
        checked(roster
          ? "T3 session exists but its current conversation is not verified; retaining the schedule."
          : "T3 roster unavailable; retaining the schedule until the next check.");
        continue;
      }
      row.bindingObservedAt = now;
      row.availability = binding.working ? "working" : binding.status === "stuck"
        ? "recovering" : binding.activity === "unknown" ? "unavailable" : "ready";
      row.publicSessionId = binding.id;
      row.browserSessionId = binding.browserSessionId;
      // A schedule created using a Bootstrap alias is normalized once the
      // durable browser owner appears. Do not retarget an in-flight delivery.
      if (!row.pendingMessageId && row.sessionId !== binding.browserSessionId &&
          !this.entries.has(binding.browserSessionId)) {
        this.entries.delete(row.sessionId);
        row.sessionId = binding.browserSessionId;
        this.entries.set(row.sessionId, row);
        changed = true;
      }

      // Both live notifications and startup journal recovery enter the SAME
      // deterministic transition model. DOM totalTurns is never an event key.
      const idle = this.latestIdle(binding.browserSessionId);
      if (idle && idle.sessionId === binding.browserSessionId) {
        const transition = reduceCaffyWake(row, { type: "idle", idle, now });
        if (Object.keys(transition.patch).length) {
          this.applyWakeTransition(row, transition.patch);
          changed = true;
        }
      }

      // Cold renderer recovery publishes through the same idle journal. A
      // roster label or DOM totalTurns alone never creates a second wake path.
      if (row.paused) checked("Paused; scheduler will not dispatch.");
      else if (row.pendingMessageId)
        checked(`Delivery ${row.deliveryStatus ?? "queued"}; awaiting exact recipient receipt.`);
      else if (row.pendingWake)
        checked(row.lastCheckResult?.includes("wake requested")
          ? row.lastCheckResult : "Wake requested; awaiting safe scheduler dispatch.");
      else if (binding.status === "stuck")
        checked("Browser guest stuck; recovery needed. No reload will overwrite a draft.");
      else if (binding.working)
        checked("Assistant working; awaiting a verified idle transition.");
      else if (row.mode === "idle" && binding.lastRole === "user")
        checked(idle?.conversationId === row.conversationId
          ? "User-only turn observed; waiting for a newer verified quiescent edge."
          : "User-only pending or stalled; waiting for verified quiescence, not a generic idle label.");
      else if (row.mode === "idle")
        checked("Waiting for a newer verified idle edge or a new guarded assistant reply.");
      else if (row.mode === "periodic")
        checked(`Next interval wake ${row.nextDueAt == null ? "not scheduled" : new Date(row.nextDueAt).toISOString()}.`);
      else checked(`${row.mode} monitor awaiting its activation conditions.`);
      if (binding.working && !row.lastActivatedAt) {
        row.lastActivatedAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * A normal unloaded guest remains in T3's persisted catalog, so only a
   * inventory resolves its current binding. Even repeated missing renderer
   * rows cannot prove durable removal; only explicit lifecycle actions retire.
   */
  async reconcileLifecycle(roster?: CaffyRoster | null): Promise<void> {
    const data = roster === undefined ? await this.loadRoster().catch(() => null) : roster;
    const entries = data?.sessions;
    if (!Array.isArray(entries) || data?.hasMore || data?.incomplete ||
        data?.total === undefined || data.total !== entries.length) return;
    const now = Date.now();
    // oxlint-disable-next-line unicorn/no-useless-spread -- Retiring a session must not alter this roster iteration.
    for (const row of [...this.entries.values()]) {
      if (row.targetKind === "t3") continue;
      const ids = [row.sessionId, row.browserSessionId, row.publicSessionId]
        .filter((id): id is string => !!id);
      // Existence is a property of the stable T3 session, NOT its current
      // conversation. Reboots and restored tabs may change conversation IDs
      // while the Caffy schedule (including its delayed start) must survive.
      const matches = entries.filter(entry => matchesCaffyOwner(entry, ids));
      if (matches.length > 1) continue;
      const found = matches[0];
      if (found) {
        // A running Caffy owns its snooze and will unsnooze on real delivery.
        // Paused Caffy cannot deliver, so user snooze removes that schedule.
        if (found.closedAt != null || found.hidden ||
            (row.paused && typeof found.snoozedUntil === "number" && found.snoozedUntil > now)) {
          this.retire(row.sessionId,
            found.closedAt != null ? "closed" : found.hidden ? "hidden" : "snoozed");
          continue;
        }
        if (row.rebootOperationId || !found.conversationId ||
            found.conversationId === row.conversationId) continue;

        // A new conversation within an existing browser session is not a
        // disappearance. Adopt it only with positive binding evidence; until
        // then preserve Caffy, but never deliver to the stale conversation.
        const nextId = found.conversationId;
        const registeredNew = UUID.test(nextId) &&
          found.bootstrapIdentity?.state === "registered" &&
          found.bootstrapIdentity.conversationId === nextId;
        const proof = registeredNew ? null : UUID.test(nextId) && found.id
          ? await this.read(row.browserSessionId ?? row.sessionId, nextId).catch(() => null) : null;
        const verified = registeredNew ||
          (proof?.conversationGuardValidated === true &&
            proof.verifiedConversationId === nextId);
        if (this.entries.get(row.sessionId) !== row) continue;
        if (!verified) {
          const detail = "Session switched conversations; Caffy retained until the new conversation is verified.";
          if (row.lastError !== detail) { row.lastError = detail; this.save(); }
          continue;
        }
        if (row.pendingMessageId) {
          // Retarget the pending wake to the new conversation. Duplicates are
          // fine, so the old message is simply cancelled and the wake re-armed.
          const oldMessageId = row.pendingMessageId;
          row.delayedPrompt = row.pendingMessageBody ?? row.delayedPrompt ?? null;
          row.pendingWake = true;
          row.pendingReason = "manual";
          row.pendingMessageId = null;
          row.pendingMessageBody = null;
          this.save();
          try { this.deliveries.cancel(oldMessageId); } catch { /* already gone */ }
        }
        row.conversationId = nextId;
        // Keep the owner cursor. Do not consume the new conversation's first
        // idle event during rebinding; the reducer must decide eligibility.
        row.lastIdleEvidenceKey = null;
        row.lastHandledIdleTurnCount = 0;
        row.lastActivatedAt = now;
        row.lastRebootAt = now;
        row.lastError = null;
        this.save();
        continue;
      }
      row.availability = "unavailable";
      row.lastCheckResult = "T3 owner absent from renderer inventory; schedule retained until inventory recovers or the session is explicitly closed.";
      this.save();
    }
  }

  private publicStatus(row: CaffyConfig): CaffyConfig {
    let receipt: Omit<DeliveryRecord, "body"> | null = null;
    if (row.pendingMessageId) {
      try { receipt = this.deliveries.status(row.pendingMessageId); } catch { /* pending journal commit */ }
    }
    const view = { ...row,
      deliveryStatus: receipt?.status ?? row.deliveryStatus ?? null,
      deliveryUpdatedAt: receipt?.updatedAt ?? row.deliveryUpdatedAt ?? null,
      deliveryAwaitingGuest: receipt?.awaitingGuest ?? row.deliveryAwaitingGuest ?? false,
      lastDeliveryResult: receipt?.lastError ?? row.lastDeliveryResult ?? null,
    };
    return { ...view, wakePhase: caffyWakePhase(view, Date.now(), view.deliveryStatus) };
  }

  /** Bounded read of durable scheduler transition receipts; avoid whole-log scans on phones. */
  private recentEvents(sessionId: string) {
    const file = NodePath.join(NodePath.dirname(this.file), "caffy-state-transitions.ndjson");
    try {
      const stat = NodeFS.statSync(file);
      const length = Math.min(stat.size, 96 * 1024);
      if (!length) return [];
      const buffer = Buffer.alloc(length);
      const handle = NodeFS.openSync(file, "r");
      try { NodeFS.readSync(handle, buffer, 0, length, stat.size - length); }
      finally { NodeFS.closeSync(handle); }
      const lines = buffer.toString("utf8").split("\n");
      return (stat.size > length ? lines.slice(1) : lines).flatMap((line) => {
        try {
          const event = JSON.parse(line) as {
            at?: string; event?: string; cause?: string; requestId?: string; sessionId?: string;
          };
          return event.sessionId === sessionId
            ? [{ at: event.at, event: event.event, cause: event.cause,
                requestId: event.requestId ?? null }] : [];
        } catch { return []; }
      }).slice(-10);
    } catch { return []; }
  }

  status(sessionId?: string) {
    this.expireTimedBusy();
    if (sessionId) {
      const row = this.lookup(sessionId);
      return row ? { ...this.publicStatus(row), recentEvents: this.recentEvents(row.sessionId) } : null;
    }
    return {
      entries: [...this.entries.values()].map(row => this.publicStatus(row)),
      scheduledSpawns: [...this.scheduledSpawns.values()].map(({ prompt: _prompt, ...job }) => job),
      agentStops: [...this.agentStops.values()],
      capacityClaims: [...this.capacityClaims.values()].map(row => ({
        messageId: row.messageId, state: row.state,
        sessionId: row.sessionId, createdAt: row.createdAt,
      })),
      keepT3Busy: this.keepT3Busy,
      maxWorking: this.maxWorking,
      shutdownWhenIdle: this.shutdownWhenIdle,
      busyUntil: this.busyUntil,
      shutdownError: this.shutdownError,
    };
  }

  /**
   * The ChatGPT header reports its exact working IDs from live DOM-native
   * session activity. The main process also reads the roster and takes the
   * UNION so a stale/filtered inventory cannot undercount active agents.
   * An unavailable header snapshot fails closed for auto-admission.
   */
  reportWorkingSnapshot(ids: readonly string[], reporterId = "default") {
    if (!Array.isArray(ids) || ids.length > 20_000 ||
        typeof reporterId !== "string" || reporterId.length > 128 ||
        !reporterId ||
        ids.some(id => typeof id !== "string" || !id.trim() || id.length > 256))
      throw new Error("Invalid working session snapshot.");
    this.workingReports.set(reporterId, { ids: new Set(ids), observedAt: Date.now() });
    if (ids.length > 0) this.shutdownIdleSince = null;
    void this.checkShutdown();
    return { accepted: true };
  }

  private expireTimedBusy(): void {
    if (this.busyUntil === null || Date.now() < this.busyUntil) return;
    this.throughput.setEnabled(false, this.busyUntil);
    this.busyUntil = null;
    this.keepT3Busy = false;
    this.shutdownIdleSince = null;
    this.save();
  }

  policy(input: {
    keepT3Busy?: boolean | undefined;
    maxWorking?: number | undefined;
    shutdownWhenIdle?: boolean | undefined;
    busyForMinutes?: number | undefined;
  }) {
    if (input.busyForMinutes !== undefined) {
      if (![60, 120, 240, 360].includes(input.busyForMinutes))
        throw new Error("busyForMinutes must be 60, 120, 240 or 360.");
      this.busyUntil = Date.now() + input.busyForMinutes * 60_000;
      this.keepT3Busy = true;
      this.shutdownWhenIdle = true;
      this.shutdownIdleSince = null;
      this.shutdownError = null;
    } else {
      // A manual switch replaces the combined schedule rather than leaving a hidden shutdown armed.
      if (this.busyUntil !== null && (input.keepT3Busy !== undefined || input.shutdownWhenIdle !== undefined)) {
        this.busyUntil = null;
        this.shutdownWhenIdle = false;
        this.keepT3Busy = false;
      }
      if (input.keepT3Busy !== undefined) this.keepT3Busy = input.keepT3Busy;
      if (input.shutdownWhenIdle !== undefined) {
        this.shutdownWhenIdle = input.shutdownWhenIdle;
        this.shutdownIdleSince = null;
        this.shutdownError = null;
      }
    }
    if (input.maxWorking !== undefined) {
      if (!Number.isInteger(input.maxWorking) || input.maxWorking < 1 || input.maxWorking > 100)
        throw new Error("maxWorking must be 1..100.");
      this.maxWorking = input.maxWorking;
    }
    this.throughput.setEnabled(this.keepT3Busy);
    this.save();
    this.backupConfiguration();
    this.deliveries.resumeAllowed();
    void this.pump();
    return { keepT3Busy: this.keepT3Busy, maxWorking: this.maxWorking,
      shutdownWhenIdle: this.shutdownWhenIdle, busyUntil: this.busyUntil,
      shutdownError: this.shutdownError };
  }


  /** Native activity is authoritative from the same orchestration projection that powers the T3 thread UI. */
  private async readNative(
    target: Pick<CaffyConfig, "environmentId" | "nativeThreadId">,
    pendingMessageId?: string,
  ): Promise<{
    status: string;
    latestRun: { ordinal: number; status: string } | null;
    messageSeen: boolean;
  } | null> {
    if (!target.environmentId || !target.nativeThreadId) return null;
    const response = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(), type: "t3.threads", action: "read",
      environmentId: target.environmentId, threadId: target.nativeThreadId,
      count: 1, ...(pendingMessageId ? { clientRequestId: pendingMessageId } : {}),
    }).catch(() => null);
    if (!response?.ok || !("data" in response) || !response.data ||
        typeof response.data !== "object") return null;
    const data = response.data as {
      environmentId?: string; threadId?: string; status?: string;
      latestRun?: { ordinal?: number; status?: string } | null;
      messageSeen?: boolean;
    };
    if (data.environmentId !== target.environmentId ||
        data.threadId !== target.nativeThreadId || typeof data.status !== "string") return null;
    const latest = data.latestRun;
    return {
      status: data.status,
      latestRun: latest && Number.isSafeInteger(latest.ordinal) && latest.ordinal! > 0 &&
        typeof latest.status === "string"
          ? { ordinal: latest.ordinal!, status: latest.status } : null,
      messageSeen: data.messageSeen === true,
    };
  }

  /** Native T3 threads have no ChatGPT browser session, conversation UUID or guest outbox. */
  private async setNative(input: {
    sessionId: string; environmentId?: string | undefined; mode: Mode;
    intervalMinutes?: number | undefined; durationMinutes?: number | undefined; onceOnly?: boolean | undefined;
    startup?: boolean | undefined; keepAwake?: boolean | undefined; respectSlots?: boolean | undefined;
    wakeNow?: boolean | undefined; beginAt?: number | null | undefined; delayedPrompt?: string | null | undefined;
    repeatPrompt?: string | undefined; autoRebootMinutes?: number | null | undefined;
    autoRebootEveryRuns?: number | null | undefined; auditRequestId?: string | undefined;
  }): Promise<CaffyConfig> {
    const threadId = input.sessionId;
    const environmentId = input.environmentId;
    if (!environmentId || !threadId || threadId.startsWith("t3:"))
      throw new Error("Native Caffy requires the original T3 thread ID and environment.");
    if (!["idle", "periodic", "startup"].includes(input.mode))
      throw new Error("Invalid native Caffy wake mode.");
    const intervalMinutes = input.intervalMinutes ?? 20;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525_600)
      throw new Error("Interval must be 1..525600 minutes.");
    if (input.durationMinutes !== undefined &&
        (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 ||
          input.durationMinutes > 525_600))
      throw new Error("Duration must be 1..525600 minutes.");
    if (input.repeatPrompt !== undefined && input.repeatPrompt.length > 29_800)
      throw new Error("Repeated prompt exceeds 29800 characters.");
    if (input.delayedPrompt != null && input.delayedPrompt.length > 29_800)
      throw new Error("Delayed prompt exceeds 29800 characters.");
    if (input.beginAt != null && (!Number.isSafeInteger(input.beginAt) ||
        input.beginAt <= Date.now() || input.beginAt > Date.now() + 90 * 24 * 60 * 60_000))
      throw new Error("Scheduled start must be within the next 90 days.");
    if (input.autoRebootMinutes != null || input.autoRebootEveryRuns != null)
      throw new Error("Native T3 threads retain their context; ChatGPT-only reboot is unavailable.");
    const id = nativeOwner(environmentId, threadId);
    const prior = this.entries.get(id);
    // Confirm exactly the requested target before recording a durable monitor.
    const native = await this.readNative({ environmentId, nativeThreadId: threadId });
    if (!native) throw new Error("Cannot verify the native T3 thread in its connected environment.");
    if (prior?.pendingMessageId &&
        (input.delayedPrompt !== undefined || input.repeatPrompt !== undefined))
      throw new Error("A native wake is pending; wait for its exact message receipt first.");
    const now = Date.now();
    const same = !!prior && prior.mode === input.mode &&
      prior.respectSlots === (input.respectSlots ?? prior.respectSlots) &&
      prior.intervalMinutes === intervalMinutes && prior.onceOnly === (input.onceOnly ?? false) &&
      (input.repeatPrompt === undefined || prior.repeatPrompt === (input.repeatPrompt.trim() || null)) &&
      (input.beginAt === undefined || prior.beginAt === input.beginAt);
    if (same) {
      const wasPaused = prior.paused;
      prior.paused = false;
      if (input.wakeNow || (prior.mode === "idle" && (wasPaused || (!prior.lastWakeAt &&
          !prior.pendingWake && !prior.pendingMessageId)))) {
        prior.pendingWake = true;
        prior.pendingReason = "manual";
      }
      this.logPauseChange(prior, wasPaused, "set:native", input.auditRequestId);
      this.save();
      void this.pump();
      return prior;
    }
    const row: CaffyConfig = {
      targetKind: "t3", environmentId, nativeThreadId: threadId,
      sessionId: id, conversationId: threadId, mode: input.mode,
      respectSlots: input.respectSlots ?? prior?.respectSlots ?? false,
      intervalMinutes, startup: input.mode === "startup" || input.startup === true,
      onceOnly: input.onceOnly ?? false, keepAwake: input.keepAwake ?? true,
      paused: false, createdAt: now,
      expiresAt: input.durationMinutes === undefined ? null :
        (input.beginAt ?? now) + input.durationMinutes * 60_000,
      beginAt: input.beginAt ?? null,
      nextDueAt: input.mode === "periodic" ? (input.beginAt ?? now + intervalMinutes * 60_000) : null,
      pendingWake: input.wakeNow === true || (input.mode === "idle" && input.beginAt == null),
      pendingReason: input.wakeNow === true || (input.mode === "idle" && input.beginAt == null)
        ? "manual" : null,
      pendingMessageId: prior?.pendingMessageId ?? null,
      pendingMessageBody: prior?.pendingMessageBody ?? null,
      nativeLastRunOrdinal: Math.max(prior?.nativeLastRunOrdinal ?? 0, native.latestRun?.ordinal ?? 0),
      nativeLastSendAttemptAt: prior?.nativeLastSendAttemptAt ?? null,
      lastIdleSequence: 0, lastWakeAt: prior?.lastWakeAt ?? null,
      lastError: null, repeatPrompt: input.repeatPrompt?.trim() || prior?.repeatPrompt || null,
      delayedPrompt: input.delayedPrompt ?? prior?.delayedPrompt ?? null,
    };
    this.entries.set(id, row);
    this.save();
    this.backupConfiguration();
    void this.pump();
    return row;
  }

  /** Reconcile exact native user-message receipts before any retry; never route through ChatGPT DOM. */
  private async pumpNative(row: CaffyConfig, now: number): Promise<void> {
    const snapshot = await this.readNative(row, row.pendingMessageId ?? undefined);
    if (this.entries.get(row.sessionId) !== row) return;
    row.lastCheckedAt = Date.now();
    row.nextCheckAt = row.lastCheckedAt + CLOCK;
    if (!snapshot) {
      row.availability = "unavailable";
      row.lastCheckResult = "Native thread unavailable; preserving scheduled wake and exact message ID.";
      row.lastError = row.lastCheckResult;
      this.save();
      return;
    }
    row.lastError = null;
    const working = ["preparing", "queued", "starting", "running", "waiting"].includes(snapshot.status) ||
      (snapshot.latestRun !== null &&
        ["preparing", "queued", "starting", "running", "waiting"].includes(snapshot.latestRun.status));
    row.availability = working ? "working" : "ready";
    const last = snapshot.latestRun;
    if (last && last.ordinal > (row.nativeLastRunOrdinal ?? 0) &&
        ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(last.status)) {
      row.nativeLastRunOrdinal = last.ordinal;
      if (last.status === "completed" && row.mode === "idle" && !row.paused &&
          !row.pendingMessageId && !row.pendingWake) {
        row.pendingWake = true;
        row.pendingReason = "idle";
      }
    }
    if (row.pendingMessageId && snapshot.messageSeen) {
      row.lastWakeAt = now;
      row.lastActivatedAt = row.lastActivatedAt ?? now;
      row.pendingMessageId = null;
      row.pendingMessageBody = null;
      row.delayedPrompt = null;
      row.nativeLastSendAttemptAt = null;
      row.deliveryStatus = "delivered";
      row.deliveryAwaitingGuest = false;
      row.lastDeliveryResult = "Exact native user message confirmed in T3 projection.";
      if (row.mode === "periodic") row.nextDueAt = now + row.intervalMinutes * 60_000;
      if (row.onceOnly) {
        this.entries.delete(row.sessionId);
        this.save();
        return;
      }
    }
    if (row.paused) { row.lastCheckResult = "Paused"; this.save(); return; }
    if (!row.pendingMessageId) {
      const due = reduceCaffyWake(row, { type: "due", now });
      this.applyWakeTransition(row, due.patch);
    }
    if (working) { row.lastCheckResult = "Native assistant is working; waiting for idle."; this.save(); return; }
    if (!row.pendingWake && !row.pendingMessageId) {
      row.lastCheckResult = "Native thread idle; awaiting the next run edge or interval.";
      this.save();
      return;
    }
    if (row.respectSlots && !(await this.acquireAutomaticAdmission(
      "wake:" + row.sessionId, row.sessionId, true,
    ))) {
      row.admissionReason = "Waiting for available capacity.";
      this.save();
      return;
    }
    if (this.entries.get(row.sessionId) !== row || row.paused) {
      if (row.respectSlots) this.releaseAutomaticAdmission("wake:" + row.sessionId);
      return;
    }
    row.admissionReason = null;
    if (!row.pendingMessageId) {
      row.pendingMessageId = NodeCrypto.randomUUID();
      row.pendingMessageBody = row.delayedPrompt ?? row.repeatPrompt ??
        "Continue working on this native T3 thread. When genuinely finished, stop Caffy for this native thread using its exact thread ID (or the sidebar Stop Caffy control).";
      row.pendingWake = false;
      row.pendingReason = null;
      row.deliveryStatus = "queued";
      this.save(); // Commit ID and body before any native send.
    }
    const messageId = row.pendingMessageId;
    const body = row.pendingMessageBody ?? WAKE_TEXT;
    if (row.nativeLastSendAttemptAt && now - row.nativeLastSendAttemptAt < CLOCK) {
      if (row.respectSlots) this.releaseAutomaticAdmission("wake:" + row.sessionId);
      return;
    }
    row.nativeLastSendAttemptAt = now;
    row.lastCheckResult = "Submitting pinned native message ID; retry only after read reconciliation.";
    this.save();
    try {
      const sent = await this.request({
        version: 1, requestId: NodeCrypto.randomUUID(),
        type: "t3.threads", action: "send", environmentId: row.environmentId,
        threadId: row.nativeThreadId, clientRequestId: messageId, message: body,
      }).catch(() => null);
      if (this.entries.get(row.sessionId) !== row || row.pendingMessageId !== messageId) return;
      const receipt = sent?.ok && "data" in sent && sent.data &&
        typeof sent.data === "object" ? sent.data as {
          messageId?: string; messageSent?: boolean; threadId?: string; environmentId?: string;
        } : null;
      if (receipt?.messageSent === true && receipt.messageId === messageId &&
          receipt.threadId === row.nativeThreadId && receipt.environmentId === row.environmentId) {
        row.pendingMessageId = null;
        row.pendingMessageBody = null;
        row.delayedPrompt = null;
        row.nativeLastSendAttemptAt = null;
        row.lastWakeAt = Date.now();
        row.lastActivatedAt = row.lastActivatedAt ?? row.lastWakeAt;
        row.deliveryStatus = "delivered";
        row.lastDeliveryResult = "Native T3 turn accepted with exact pinned message ID.";
        row.lastCheckResult = "Native wake accepted; awaiting assistant completion.";
        if (row.mode === "periodic") row.nextDueAt = row.lastWakeAt + row.intervalMinutes * 60_000;
        if (row.onceOnly) this.entries.delete(row.sessionId);
      } else {
        row.lastError = "Native send unconfirmed; will read exact message ID before retry.";
        row.lastDeliveryResult = sent && !sent.ok ? sent.message : row.lastError;
      }
      this.save();
    } finally {
      if (row.respectSlots) this.releaseAutomaticAdmission("wake:" + row.sessionId);
    }
  }

  async set(input: {
    sessionId: string; conversationId: string; mode: Mode;
    targetKind?: "chatgpt" | "t3" | undefined; environmentId?: string | undefined;
    respectSlots?: boolean | undefined;
    durationMinutes?: number | undefined; onceOnly?: boolean | undefined; startup?: boolean | undefined;
    intervalMinutes?: number | undefined; keepAwake?: boolean | undefined;
    wakeNow?: boolean | undefined;
    beginAt?: number | null | undefined;
    delayedPrompt?: string | null | undefined;
    repeatPrompt?: string | undefined;
    auditRequestId?: string | undefined;
    autoRebootMinutes?: number | null | undefined;
    autoRebootEveryRuns?: number | null | undefined;
  }) {
    if (input.targetKind === "t3") return this.setNative(input);
    if (!UUID.test(input.sessionId) || !UUID.test(input.conversationId))
      throw new Error("Exact sessionId and conversationId UUIDs required.");
    if (!["idle", "periodic", "startup"].includes(input.mode))
      throw new Error("Caffy mode must be idle (keep running), periodic (interval) or startup.");
    if (input.durationMinutes !== undefined &&
        (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 525_600))
      throw new Error("Duration must be 1..525600 minutes or omitted for infinite.");
    if (input.mode === "startup" && input.startup === false)
      throw new Error("Startup-only Caffy requires startup=true.");
    if (input.mode === "startup" && input.durationMinutes !== undefined)
      throw new Error("Startup-only Caffy is infinite; omit duration.");
    const intervalMinutes = input.intervalMinutes ?? 20;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525_600)
      throw new Error("Interval must be 1..525600 minutes.");
    if (input.repeatPrompt !== undefined && input.repeatPrompt.length > 29_800)
      throw new Error("Recurring prompt exceeds 29800 characters.");
    if (input.autoRebootMinutes != null && (!Number.isInteger(input.autoRebootMinutes) ||
        input.autoRebootMinutes < 1 || input.autoRebootMinutes > 525_600))
      throw new Error("Reboot interval must be 1..525600 minutes.");
    if (input.autoRebootEveryRuns != null && (!Number.isInteger(input.autoRebootEveryRuns) ||
        input.autoRebootEveryRuns < 1 || input.autoRebootEveryRuns > 10_000))
      throw new Error("Reboot run interval must be 1..10000.");
    if (input.autoRebootMinutes != null && input.autoRebootEveryRuns != null)
      throw new Error("Select either a reboot interval or a run count.");
    // Scheduling is a durable local preference, not a message send. Do not
    // block its save on a renderer roster/guarded read; the pump verifies the
    // current conversation before enqueuing any wake.
    const known = this.lookup(input.sessionId);
    const browserSessionId = known?.browserSessionId ?? known?.sessionId ?? input.sessionId;
    const canonicalId = browserSessionId;
    if (this.terminalConversations.get(canonicalId) === input.conversationId ||
        this.terminalConversations.get(input.sessionId) === input.conversationId)
      throw new Error("This conversation reached its maximum length. Reboot the session before enabling Caffy.");
    if ([...this.entries.values()].some(row => row.conversationId === input.conversationId &&
        row.sessionId !== canonicalId && row.browserSessionId !== input.sessionId &&
        row.publicSessionId !== input.sessionId))
      throw new Error("Another T3 Caffy monitor already owns this ChatGPT conversation.");
    if (this.legacyConflict(canonicalId, input.conversationId) ||
        this.legacyConflict(input.sessionId, input.conversationId))
      throw new Error("Legacy OmniHub Caffy monitor still owns this session; cancel it before scheduling T3 Caffy.");
    const now = Date.now();
    if (input.beginAt !== undefined && input.beginAt !== null &&
        (!Number.isSafeInteger(input.beginAt) || input.beginAt <= now ||
          input.beginAt > now + 90 * 24 * 60 * 60_000))
      throw new Error("Scheduled start must be in the next 90 days.");
    const prior = this.lookup(input.sessionId);
    // "Resume on idle" means start continuing immediately, including when
    // the agent was already idle BEFORE Caffy was enabled. A caller's
    // wakeNow=false must not disable this invariant. Arm the durable wake
    // without requiring a fresh assistant-completed edge: the scheduler and
    // guarded delivery still verify the exact recipient and wait for idle.
    // Re-arming a previously never-woken idle schedule also repairs old
    // configurations created with wakeNow=false.
    const resumeOnIdle = input.mode === "idle" && input.onceOnly !== true;
    const initialIdleWake = resumeOnIdle &&
      (!prior || prior.paused || prior.mode !== "idle" || prior.onceOnly ||
        prior.conversationId !== input.conversationId ||
        (!prior.pendingWake && !prior.pendingMessageId && prior.lastWakeAt === null));
    // A newly configured one-off continuation waits for the next safe idle;
    // no live renderer read is necessary while saving the schedule.
    const initialOnceWake = input.mode === "idle" && input.onceOnly === true &&
      input.wakeNow === undefined &&
      (!prior || prior.paused || prior.mode !== "idle" ||
        prior.conversationId !== input.conversationId);
    const armWake = input.wakeNow === true || initialIdleWake || initialOnceWake;
    // A fresh manual Caffy setup supersedes any earlier "agent stopped" marker.
    for (const [key, mark] of this.agentStops) {
      if ([mark.sessionId, mark.browserSessionId, mark.publicSessionId].some(id =>
          id === input.sessionId || id === canonicalId || id === identity?.id))
        this.agentStops.delete(key);
    }
    if ((input.delayedPrompt || input.repeatPrompt !== undefined) && prior?.pendingMessageId)
      throw new Error("Existing Caffy delivery is pending; inspect it before changing its prompt.");
    if (prior?.pendingMessageId &&
        (prior.conversationId !== input.conversationId || prior.sessionId !== canonicalId))
      throw new Error("Existing wake delivery needs reconciliation before changing its recipient identity.");
    const mode = input.mode;
    const respectSlots = input.respectSlots ?? prior?.respectSlots ?? false;
    const same = !!prior && prior.conversationId === input.conversationId &&
      prior.mode === mode && prior.respectSlots === respectSlots && prior.expiresAt ===
        (input.durationMinutes === undefined ? null : prior.createdAt + input.durationMinutes * 60_000) &&
      prior.onceOnly === (input.onceOnly ?? false) &&
      prior.startup === (input.startup ?? (input.mode === "startup")) &&
      prior.keepAwake === (input.keepAwake ?? true) &&
      prior.intervalMinutes === intervalMinutes &&
      (input.repeatPrompt === undefined || (prior.repeatPrompt ?? "") === input.repeatPrompt.trim()) &&
      (input.autoRebootMinutes === undefined || (prior.autoRebootMinutes ?? null) === input.autoRebootMinutes) &&
      (input.autoRebootEveryRuns === undefined || (prior.autoRebootEveryRuns ?? null) === input.autoRebootEveryRuns);
    if (same) {
      if ((input.beginAt !== undefined && input.beginAt !== prior.beginAt) ||
          (input.delayedPrompt !== undefined && input.delayedPrompt !== prior.delayedPrompt)) {
        if (input.beginAt !== undefined) prior.beginAt = input.beginAt;
        prior.delayedPrompt = input.delayedPrompt ?? null;
        prior.pendingWake = true;
        prior.pendingReason = "manual";
        this.save();
        this.backupConfiguration();
      }
      if (armWake && !prior.pendingWake && !prior.pendingMessageId) {
        prior.pendingWake = true;
        prior.pendingReason = "manual";
        this.save();
        void this.pump();
      }
      if (prior.paused) {
        prior.paused = false;
        this.logPauseChange(prior, true, "set:identical-config", input.auditRequestId);
        prior.lastError = null;
        this.save();
        this.backupConfiguration();
        void this.pump();
      }
      // A revised one-off message/start can re-arm a matching policy.
      // Dispatch immediately rather than waiting for the next scheduler tick.
      if (prior.pendingWake && !prior.paused) void this.pump();
      return prior;
    }
    const journalIdle = this.latestIdle(browserSessionId);
    const initialIdleSequence = journalIdle?.conversationId === input.conversationId &&
      journalIdle.sessionId === browserSessionId ? journalIdle.sequence : 0;
    const continuingSameMonitor = prior?.mode === mode &&
      prior.conversationId === input.conversationId;
    const row: CaffyConfig = {
      sessionId: canonicalId, browserSessionId,
      publicSessionId: prior?.publicSessionId ?? input.sessionId,
      conversationId: input.conversationId,
      mode, respectSlots, intervalMinutes,
      startup: mode === "startup" ? true : input.startup ?? false, onceOnly: input.onceOnly ?? false,
      keepAwake: input.keepAwake ?? true, paused: false, createdAt: now,
      expiresAt: input.durationMinutes === undefined ? null :
        Math.max(now, input.beginAt ?? prior?.beginAt ?? now) + input.durationMinutes * 60_000,
      nextDueAt: mode === "periodic" ? input.beginAt ?? now + intervalMinutes * 60_000 : null,
      pendingWake: armWake,
      pendingReason: armWake ? "manual" : null,
      pendingMessageId: prior?.conversationId === input.conversationId ? prior.pendingMessageId : null,
      lastIdleSequence: continuingSameMonitor ? (prior?.lastIdleSequence ?? 0) : initialIdleSequence,
      lastHandledIdleEventId: (continuingSameMonitor ? prior?.lastHandledIdleEventId : journalIdle?.eventId) ?? null,
      lastIdleEvidenceKey: (continuingSameMonitor ? prior?.lastIdleEvidenceKey : journalIdle?.evidenceKey) ?? null,
      lastHandledIdleTurnCount: continuingSameMonitor
        ? prior?.lastHandledIdleTurnCount ?? 0
        : journalIdle?.conversationId === input.conversationId &&
          journalIdle.sessionId === browserSessionId ? journalIdle.turnCount : 0,
      lastWakeAt: prior?.lastWakeAt ?? null, lastError: null,
      beginAt: input.beginAt !== undefined ? input.beginAt : prior?.beginAt ?? null,
      delayedPrompt: input.delayedPrompt !== undefined ? input.delayedPrompt : prior?.delayedPrompt ?? null,
      repeatPrompt: input.repeatPrompt !== undefined ? input.repeatPrompt.trim() || null : prior?.repeatPrompt ?? null,
      pendingMessageBody: prior?.pendingMessageBody ?? null,
      autoRebootMinutes: input.autoRebootMinutes !== undefined ? input.autoRebootMinutes : prior?.autoRebootMinutes ?? null,
      autoRebootEveryRuns: input.autoRebootEveryRuns !== undefined ? input.autoRebootEveryRuns : prior?.autoRebootEveryRuns ?? null,
      wakesSinceReboot: prior?.wakesSinceReboot ?? 0,
      lastCountedWakeAt: prior?.lastCountedWakeAt ?? null,
      lastActivatedAt: prior?.lastActivatedAt ?? null,
      lastRebootAt: prior?.lastRebootAt ?? null,
      rebootOperationId: prior?.rebootOperationId ?? null,
      rebootOldConversationId: prior?.rebootOldConversationId ?? null,
    };
    if (prior && prior.sessionId !== row.sessionId) this.entries.delete(prior.sessionId);
    this.entries.set(row.sessionId, row);
    if (prior) this.logPauseChange(row, prior.paused, "set:reconfigured", input.auditRequestId);
    this.save();
    this.backupConfiguration();
    void this.pump();
    return row;
  }

  /**
   * Lifecycle retirement is terminal. Nothing left queued for this recipient
   * may be retried or automatically remounted after close / hide / snooze.
   * The outbox keeps an audit of any attempted but uncertain sends.
   */
  retire(
    sessionId: string,
    reason: "closed" | "hidden" | "snoozed" | "missing" | "stopped",
    stopInitiator: "user" | "agent" = "agent",
  ) {
    const row = this.lookup(sessionId);
    const ids = row
      ? [...new Set([sessionId, row.sessionId, row.browserSessionId, row.publicSessionId]
          .filter((id): id is string => !!id))]
      : [sessionId];
    if (row) {
      this.entries.delete(row.sessionId);
      if (reason === "stopped" && stopInitiator === "agent") {
        this.agentStops.set(row.sessionId, {
          sessionId: row.sessionId,
          browserSessionId: row.browserSessionId,
          publicSessionId: row.publicSessionId,
          stoppedAt: Date.now(),
        });
      } else if (reason === "stopped") {
        this.agentStops.delete(row.sessionId);
      }
    }
    const detail = `Recipient ${reason}; Caffy delivery retired.`;
    const cancelled = row?.targetKind === "t3" ? 0 : this.deliveries.retireRecipient(ids, row?.conversationId ?? null,
      detail, reason === "snoozed" || reason === "hidden" || reason === "stopped");
    if (row) {
          this.save();
    }
    return { stopped: !!row, cancelled };
  }

  /** Permanently retire every wake for this exhausted conversation, until a new chat is booted. */
  terminal(sessionId: string, conversationId: string) {
    if (!UUID.test(sessionId) || !UUID.test(conversationId))
      throw new Error("Exact ChatGPT session and conversation IDs required.");
    this.terminalConversations.set(sessionId, conversationId);
    const row = this.lookup(sessionId);
    if (row?.conversationId === conversationId) this.retire(row.sessionId, "stopped");
    this.deliveries.retireRecipient([sessionId], conversationId,
      "ChatGPT conversation reached maximum length; reboot required.", true);
    this.save();
    return { terminal: true, sessionId, conversationId };
  }

  stop(sessionId: string, initiator: "user" | "agent" = "agent") {
    const { stopped } = this.retire(sessionId, "stopped", initiator);
    return { stopped };
  }

  private validateScheduledSpawnCaffy(value: ScheduledSpawnCaffy | null | undefined) {
    if (!value) return;
    if (!["idle", "periodic"].includes(value.mode) ||
        typeof value.respectSlots !== "boolean" ||
        !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 ||
        value.intervalMinutes > 525_600 ||
        (value.durationMinutes !== undefined && (!Number.isInteger(value.durationMinutes) ||
          value.durationMinutes < 1 || value.durationMinutes > 525_600)) ||
        (value.repeatPrompt !== undefined && value.repeatPrompt.length > 29_800) ||
        (value.autoRebootMinutes != null && (!Number.isInteger(value.autoRebootMinutes) ||
          value.autoRebootMinutes < 1 || value.autoRebootMinutes > 525_600)) ||
        (value.autoRebootEveryRuns != null && (!Number.isInteger(value.autoRebootEveryRuns) ||
          value.autoRebootEveryRuns < 1 || value.autoRebootEveryRuns > 10_000)) ||
        (value.autoRebootMinutes != null && value.autoRebootEveryRuns != null))
      throw new Error("Invalid Caffy continuation settings for scheduled session.");
  }

  scheduleSpawn(input: { id: string; title: string; prompt: string; beginAt: number | null; onIdle?: boolean; project?: string; caffy?: ScheduledSpawnCaffy | null }) {
    if (!UUID.test(input.id)) throw new Error("Scheduled job requires a stable UUID.");
    if (!input.title.trim() || input.title.length > 120 ||
        !input.prompt.trim() || input.prompt.length > 29_800)
      throw new Error("Provide a title and a prompt (maximum 29800 characters).");
    if (input.onIdle === true ? input.beginAt !== null :
        input.beginAt === null || !Number.isSafeInteger(input.beginAt) ||
        input.beginAt <= Date.now() || input.beginAt > Date.now() + 90 * 24 * 60 * 60_000)
      throw new Error("Choose either the next available agent slot or a future time within 90 days.");
    this.validateScheduledSpawnCaffy(input.caffy);
    const existing = this.scheduledSpawns.get(input.id);
    if (existing) {
      if (existing.title !== input.title || existing.prompt !== input.prompt ||
          existing.beginAt !== input.beginAt ||
          (existing.onIdle === true) !== (input.onIdle === true) ||
          existing.project !== input.project ||
          JSON.stringify(existing.caffy ?? null) !== JSON.stringify(input.caffy ?? null))
        throw new Error("Scheduled job ID belongs to a different request.");
      return { id: existing.id, status: existing.status, beginAt: existing.beginAt };
    }
    this.scheduledSpawns.set(input.id, { ...input, status: "scheduled" });
    this.save();
    void this.pump();
    return { id: input.id, status: "scheduled", beginAt: input.beginAt };
  }

  /** Read the full prompt only for an explicitly selected scheduled sidebar entry. */
  readScheduledSpawn(id: string) {
    const job = this.scheduledSpawns.get(id);
    if (!job) throw new Error("Scheduled session not found.");
    if (job.status !== "scheduled")
      throw new Error("Session creation already started; this schedule can no longer be edited.");
    return { ...job };
  }

  /** Replace rather than mutate: a concurrently admitted dispatch must recheck identity. */
  updateScheduledSpawn(input: { id: string; title: string; prompt: string; beginAt: number | null; onIdle?: boolean; caffy?: ScheduledSpawnCaffy | null }) {
    const job = this.readScheduledSpawn(input.id);
    if (!input.title.trim() || input.title.length > 120 ||
        !input.prompt.trim() || input.prompt.length > 29_800)
      throw new Error("Provide a prompt (maximum 29800 characters).");
    this.validateScheduledSpawnCaffy(input.caffy);
    const now = Date.now();
    if (input.onIdle === true ? input.beginAt !== null :
        input.beginAt === null || !Number.isSafeInteger(input.beginAt) ||
        (input.beginAt <= now && input.beginAt !== job.beginAt) ||
        input.beginAt > now + 90 * 24 * 60 * 60_000)
      throw new Error("Choose a future start within 90 days, or the next available agent slot.");
    this.scheduledSpawns.set(job.id, {
      ...job, title: input.title.trim(), prompt: input.prompt.trim(),
      beginAt: input.beginAt, onIdle: input.onIdle === true,
      caffy: input.caffy ?? null,
    });
    this.save();
    void this.pump();
    return { id: job.id, status: "scheduled" as const, beginAt: input.beginAt };
  }

  cancelScheduledSpawn(id: string) {
    const job = this.scheduledSpawns.get(id);
    if (!job) throw new Error("Scheduled job not found.");
    if (job.status !== "scheduled")
      throw new Error("Creation may already have started. Inspect its receipt before changing it.");
    this.scheduledSpawns.delete(id);
    this.save();
    return { cancelled: true, id };
  }

  /** Attach continuation only once the new session's real conversation binding is visible. */
  private async activateCreatedSpawnCaffy(): Promise<void> {
    const pending = [...this.scheduledSpawns.values()].filter(job =>
      job.status === "created" && job.caffy && !job.caffyAppliedAt && job.sessionId);
    if (!pending.length) return;
    const roster = await this.loadRoster().catch(() => null);
    if (!roster || roster.hasMore || roster.incomplete) return;
    for (const job of pending) {
      if (this.scheduledSpawns.get(job.id) !== job || !job.sessionId || !job.caffy) continue;
      const matching = roster.sessions.filter(entry =>
        entry.id === job.sessionId || entry.browserSessionId === job.sessionId);
      if (matching.length !== 1) continue;
      const owner = matching[0]!;
      if (owner.closedAt != null || owner.hidden) continue;
      const conversationId = owner.conversationId ?? owner.bootstrapIdentity?.conversationId;
      if (!conversationId || !UUID.test(conversationId)) continue;
      const bound = this.bindingInRoster(roster, job.sessionId, conversationId);
      if (!bound) continue;
      try {
        await this.set({
          sessionId: bound.browserSessionId, conversationId,
          mode: job.caffy.mode, respectSlots: job.caffy.respectSlots,
          intervalMinutes: job.caffy.intervalMinutes,
          durationMinutes: job.caffy.durationMinutes,
          onceOnly: false, keepAwake: false,
          // Idle mode waits for the initial prompt to finish; periodic mode
          // starts its interval from the verified session attachment.
          wakeNow: job.caffy.mode === "idle",
          beginAt: null, repeatPrompt: job.caffy.repeatPrompt ?? "",
          autoRebootMinutes: job.caffy.autoRebootMinutes ?? null,
          autoRebootEveryRuns: job.caffy.autoRebootEveryRuns ?? null,
        });
        job.caffyAppliedAt = Date.now();
        delete job.caffyError;
        this.save();
      } catch (error) {
        const message = String(error);
        if (job.caffyError !== message) {
          job.caffyError = message;
          this.save();
        }
      }
    }
  }

  private async dispatchScheduledSpawn(now: number) {
    const job = [...this.scheduledSpawns.values()]
      .filter(item => item.status === "scheduled" &&
        (item.onIdle === true || (item.beginAt !== null && item.beginAt <= now)))
      .sort((a, b) => (a.beginAt ?? 0) - (b.beginAt ?? 0))[0];
    if (!job) return;
    const ticket = `scheduled-spawn:${job.id}`;
    if (!(await this.acquireAutomaticAdmission(ticket, undefined, true))) return;
    try {
      if (this.scheduledSpawns.get(job.id) !== job || job.status !== "scheduled") return;
      // Persist the one-way transition before requesting creation. After a crash
      // the same prompt must never be spawned again without receipt inspection.
      job.status = "dispatching";
      this.save();
      try {
        const reply = await this.request({
          version: 1, requestId: job.id, type: "chatgpt.spawn",
          title: job.title, prompt: job.prompt,
          ...(job.project ? { project: job.project } : {}),
          role: "personal",
        });
        if (reply.ok && "data" in reply && reply.data &&
            typeof reply.data === "object" && "sessionId" in reply.data &&
            typeof reply.data.sessionId === "string") {
          job.status = "created";
          job.sessionId = reply.data.sessionId;
          if (job.onIdle === true) this.throughput.recordSession(`scheduled:${job.id}`);
          job.holdUntil = Date.now() + 180_000;
          delete job.error;
        } else {
          job.status = "uncertain";
          job.error = reply.ok ? "Spawn receipt did not confirm a session ID." :
            reply.message;
        }
      } catch (error) {
        job.status = "uncertain";
        job.error = String(error);
      }
      this.save();
    } finally {
      this.releaseAutomaticAdmission(ticket);
    }
  }

  cancelDelayedPrompt(sessionId: string) {
    const row = this.lookup(sessionId);
    if (!row) return { cleared: true };
    if (row.pendingMessageId) {
      const messageId = row.pendingMessageId;
      row.pendingMessageId = null;
      row.pendingMessageBody = null;
      try { this.deliveries.cancel(messageId); } catch { /* already gone */ }
    }
    if (row.onceOnly && row.mode === "idle") {
      return { cleared: true, stopped: this.stop(sessionId, "user").stopped };
    }
    row.delayedPrompt = null;
    row.pendingMessageBody = null;
    row.beginAt = null;
    row.pendingWake = false;
    row.pendingReason = null;
    this.save();
    return { cleared: true };
  }

  /** One-off prompt at a time; `respectSlots` applies only when this creates the row. */
  async beginAt(sessionId: string, conversationId: string, at: number | null, prompt?: string, respectSlots = false, auditRequestId?: string) {
    if (prompt !== undefined && (!prompt.trim() || prompt.length > 29_800))
      throw new Error("Delayed prompt must contain 1..29800 characters.");
    if (at !== null && (!Number.isSafeInteger(at) || at <= Date.now() ||
        at > Date.now() + 90 * 24 * 60 * 60_000))
      throw new Error("Begin working must be within the next 90 days.");
    let row = this.lookup(sessionId);
    if (!row) {
      if (at === null) return { cleared: true };
      return await this.set({ sessionId, conversationId, mode: "idle", respectSlots,
        onceOnly: true, keepAwake: false, beginAt: at, delayedPrompt: prompt ?? null, auditRequestId });
    }
    if (row.targetKind === "t3") conversationId = row.conversationId;
    if (row.conversationId !== conversationId)
      throw new Error("Delayed start requires the same registered conversation.");
    if (row.rebootOperationId) throw new Error("A reboot is awaiting reconciliation.");
    if (at !== null && row.targetKind !== "t3" && this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor owns this session; cannot resume T3 Caffy.");
    if (at === null && row.onceOnly && row.mode === "idle" &&
        row.beginAt !== null && row.beginAt !== undefined && row.lastWakeAt === null) {
      return { cleared: true, stopped: this.stop(sessionId).stopped };
    }
    if (row.pendingMessageId) {
      // Delaying replaces any pending wake (it may already have landed; that's fine).
      const messageId = row.pendingMessageId;
      row.pendingMessageId = null;
      row.pendingMessageBody = null;
      try { this.deliveries.cancel(messageId); } catch { /* already gone */ }
    }
    if (row.expiresAt !== null) {
      const base = row.beginAt ?? row.createdAt;
      const duration = Math.max(60_000, row.expiresAt - base);
      row.expiresAt = (at ?? Date.now()) + duration;
    }
    row.beginAt = at;
    row.delayedPrompt = at === null ? null : prompt ?? null;
    row.pendingWake = true;
    row.pendingReason = "manual";
    if (at !== null) {
      // The renderer first pauses the live monitor while clicking Stop.
      // Persist the future deadline AND the resumed scheduler atomically, so
      // a lost follow-up IPC cannot leave Caffy permanently paused.
      const wasPaused = row.paused;
      row.paused = false;
      this.logPauseChange(row, wasPaused, "begin_in:scheduled-start", auditRequestId);
      row.lastError = null;
    }
    this.save();
    this.backupConfiguration();
    if (at === null) void this.pump();
    return row;
  }

  /** Non-temporal edits never re-arm stopped monitors or resume paused ones. */
  configure(sessionId: string, input: { respectSlots?: boolean; repeatPrompt?: string }) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("Caffy is not running for this session.");
    if (input.repeatPrompt !== undefined) {
      if (input.repeatPrompt.length > 29_800)
        throw new Error("Repeated prompt exceeds 29800 characters.");
      if (row.pendingMessageId)
        throw new Error("An existing wake delivery must settle before changing the repeated prompt.");
    }
    if (input.respectSlots !== undefined) {
      // Older T3 schedulers used a distinct queued mode and do not have
      // slot-admission policy. Fail closed rather than pretending it changed.
      if (!("respectSlots" in row))
        throw new Error("The running Caffy scheduler does not support in-place slot policy changes. Upgrade T3 first.");
      row.respectSlots = input.respectSlots;
    }
    if (input.repeatPrompt !== undefined) row.repeatPrompt = input.repeatPrompt.trim() || null;
    this.save();
    this.backupConfiguration();
    if (!row.paused) void this.pump();
    return row;
  }

  autoReboot(sessionId: string, minutes: number | null, everyRuns: number | null = null) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("Configure Auto-continue before enabling auto-reboot.");
    if (row.targetKind === "t3" && (minutes !== null || everyRuns !== null))
      throw new Error("Native T3 threads keep their context; ChatGPT-only auto-reboot is unavailable.");
    if ((minutes !== null || everyRuns !== null) && row.onceOnly)
      throw new Error("Auto-reboot requires recurring work, not Once only.");
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600))
      throw new Error("Auto-reboot interval must be 1..525600 minutes.");
    if (everyRuns !== null && (!Number.isInteger(everyRuns) || everyRuns < 1 || everyRuns > 10_000))
      throw new Error("Auto-reboot run count must be 1..10000.");
    if (minutes !== null && everyRuns !== null)
      throw new Error("Select a reboot interval or a run count.");
    row.autoRebootMinutes = minutes;
    row.autoRebootEveryRuns = everyRuns;
    this.save();
    this.backupConfiguration();
    return row;
  }

  /** Reboot replaces the ChatGPT conversation inside the SAME T3 browser slot.
   * No second begin is authorized while the existing operation is UNKNOWN.
   * Only a new registered bootstrap binding can switch Caffy to that conversation. */
  private async reconcileReboot(row: CaffyConfig): Promise<void> {
    if (!row.rebootOperationId) return;
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    }).catch(() => null);
    if (!reply?.ok || !("data" in reply) || !reply.data ||
        typeof reply.data !== "object") return;
    const data = reply.data as {sessions?: Array<{
      id?: string; browserSessionId?: string; publicSessionId?: string;
      conversationId?: string; bootstrapIdentity?: {
        state?: string; publicId?: string; conversationId?: string;
      }; lastIdleTransition?: {conversationId?: string; sequence?: number};
    }>};
    const matches = (data.sessions ?? []).filter(entry => matchesCaffyOwner(entry,
      [row.sessionId, row.browserSessionId, row.publicSessionId]));
    if (matches.length !== 1) return;
    const entry = matches[0]!;
    const nextId = entry.conversationId;
    if (!nextId || !UUID.test(nextId) || nextId === row.rebootOldConversationId ||
        entry.bootstrapIdentity?.conversationId !== nextId ||
        entry.bootstrapIdentity?.state !== "registered") return;
    row.conversationId = nextId;
    row.publicSessionId = entry.bootstrapIdentity.publicId ?? row.publicSessionId;
    row.lastIdleEvidenceKey = null;
    row.lastHandledIdleTurnCount = 0;
    row.lastActivatedAt = Date.now();
    row.lastRebootAt = Date.now();
    row.wakesSinceReboot = 0;
    row.rebootOperationId = null;
    row.rebootOldConversationId = null;
    // Preserve the due continuation; reboot is preparation, not a run.
    row.lastError = null;
    this.save();
  }

  private async beginAutoReboot(row: CaffyConfig): Promise<void> {
    if (row.rebootOperationId || row.pendingMessageId) return;
    // Prefer the exact original human assignment, if this still-mounted
    // predecessor can provide a guarded read. Never allow a missing/ambiguous
    // read to block the scheduler: the continuation prompt remains sufficient.
    const original = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "read",
      sessionId: row.sessionId, expectedConversationId: row.conversationId,
      from: "start", count: 1, maxMessageChars: 20_000,
    }).catch(() => null);
    if (this.entries.get(row.sessionId) !== row || row.pendingMessageId ||
        row.paused || row.rebootOperationId) return;
    const bound = await this.registered(row.sessionId, row.conversationId).catch(() => null);
    // pump() already holds the atomic admission for this due wake.
    // Rechecking capacity here would count our own reservation as a competitor.
    if (!bound || bound.working || this.entries.get(row.sessionId) !== row) return;
    const evidence = original?.ok && "data" in original && original.data &&
      typeof original.data === "object" ? original.data as {
        conversationGuardValidated?: boolean; verifiedConversationId?: string;
        session?: {messages?: Array<{role?: string; text?: string}>};
      } : null;
    const originalText = evidence?.conversationGuardValidated === true &&
      evidence.verifiedConversationId === row.conversationId
        ? evidence.session?.messages?.find(m => m.role === "user")?.text?.trim() : null;
    const prompt = "This is a context handover for an automatic Caffy reboot within the SAME T3 session. " +
      "Do not execute or repeat the assignment yet: Caffy will send the next scheduled prompt " +
      "after this handover is complete. Read the original assignment below for context, " +
      "acknowledge it briefly and finish this turn.\n" +
      (originalText && originalText.length <= 20_000
        ? "\nOriginal user assignment (for context, not a request to redo completed steps):\n" +
          originalText : "\nReview your original assignment and project instructions.");
    const operationId = NodeCrypto.randomUUID();
    row.rebootOperationId = operationId;
    row.rebootOldConversationId = row.conversationId;
    // Retain the due continuation until the new conversation is verified.
    this.save(); // durable before potentially changing any browser state
    const reply = await this.request({
      version: 1, requestId: operationId,
      type: "chatgpt.reboot", sessionId: row.sessionId,
      priorConversationId: row.conversationId,
      prompt, phase: "begin",
    }).catch(() => null);
    if (this.entries.get(row.sessionId) !== row) return;
    const data = reply?.ok && "data" in reply && reply.data &&
      typeof reply.data === "object" ? reply.data as {status?: string} : null;
    if (!data || !["submitted", "committed", "restored"].includes(data.status ?? "")) {
      row.lastError = "Auto-reboot outcome unconfirmed. Operation " + operationId +
        " retained for read-only reconciliation; no duplicate reboot will start.";
      this.save();
      return;
    }
    row.lastRebootAt = Date.now();
    row.lastActivatedAt = row.lastRebootAt;
    row.lastError = null;
    this.save();
    await this.reconcileReboot(row);
  }

  pause(sessionId: string, paused: boolean, auditRequestId?: string) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
    if (!paused && row.targetKind !== "t3" && this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor still owns this session; cancel it before resuming T3 Caffy.");
    const wasPaused = row.paused;
    row.paused = paused;
    // A command-driven resume must not leave an already-idle recurring
    // monitor waiting indefinitely for a brand-new idle transition.
    if (wasPaused && !paused && row.mode === "idle" && !row.onceOnly &&
        !row.pendingWake && !row.pendingMessageId) {
      row.pendingWake = true;
      row.pendingReason = "manual";
    }
    this.logPauseChange(row, wasPaused, paused ? "pause:explicit" : "resume:explicit", auditRequestId);
    this.save();
    this.backupConfiguration();
    if (!paused) { this.deliveries.resumeAllowed(); void this.pump(); }
    return row;
  }

  startup(sessionId: string, enabled: boolean) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
    if (!enabled && row.mode === "startup") return this.stop(sessionId);
    row.startup = enabled;
    this.save();
    this.backupConfiguration();
    return row;
  }

  wake(sessionId: string) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
    if (row.targetKind !== "t3" && this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor still owns this session; cancel it before waking.");
    row.pendingWake = true;
    row.pendingReason = "manual";
    this.save();
    void this.pump();
    return row;
  }

  onIdle(event: VerifiedChatGPTIdleTransition) {
    // The T3 browser/session ID is the owner. Matching by conversation alone
    // can redirect a wake across reboots or unrelated sessions.
    const row = this.lookup(event.sessionId);
    if (!row || row.targetKind === "t3") return;
    const transition = reduceCaffyWake(row, { type: "idle", idle: event, now: Date.now() });
    if (!Object.keys(transition.patch).length) return;
    this.applyWakeTransition(row, transition.patch);
    if (event.kind === "completed" && row.lastWakeAt !== null &&
        event.observedAt > row.lastWakeAt &&
        row.lastWakeAt > (row.lastCountedWakeAt ?? 0)) {
      row.wakesSinceReboot = (row.wakesSinceReboot ?? 0) + 1;
      row.lastCountedWakeAt = row.lastWakeAt;
    }
    row.lastCheckedAt = Date.now();
    row.nextCheckAt = row.lastCheckedAt + 30_000;
    this.save();
    if (transition.requested) void this.pump();
  }

  private applyWakeTransition(row: CaffyConfig, patch: Partial<CaffyConfig>) {
    if (!Object.keys(patch).length) return;
    Object.assign(row, patch);
    row.transitionVersion = (row.transitionVersion ?? 0) + 1;
  }

  private onDelivery(record: Omit<DeliveryRecord, "body">) {
    const row = this.lookup(record.sessionId);
    if (!row || row.targetKind === "t3" || row.pendingMessageId !== record.messageId) return;
    this.applyWakeTransition(row, reduceCaffyWake(row, {
      type: "delivery", receipt: record, now: Date.now(),
    }).patch);
    if (record.status === "delivered" && row.onceOnly) this.entries.delete(row.sessionId);
    this.save();
  }

  private async loadRoster(): Promise<CaffyRoster | null> {
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    });
    if (!reply.ok || !("data" in reply) || !reply.data ||
        typeof reply.data !== "object") return null;
    const data = reply.data as Partial<CaffyRoster>;
    return Array.isArray(data.sessions) ? data as CaffyRoster : null;
  }

  private bindingInRoster(
    roster: CaffyRoster, sessionId: string, conversationId: string,
  ): { id: string; browserSessionId: string; working: boolean; idleSequence: number;
      activity?: string | undefined; status?: string | undefined; lastRole?: string | undefined } | null {
    const known = this.lookup(sessionId);
    const matches = roster.sessions.filter(entry => matchesCaffyOwner(entry,
      [sessionId, known?.browserSessionId, known?.publicSessionId]));
    const entry = matches.length === 1 ? matches[0] : null;
    if (!entry?.id || entry.closedAt != null ||
        // Current T3 roster binding outranks an obsolete Bootstrap identity.
        (entry.conversationId
          ? entry.conversationId !== conversationId
          : entry.bootstrapIdentity?.conversationId !== conversationId)) return null;
    const browserSessionId = entry.browserSessionId ??
      (entry.lastIdleTransition?.conversationId === conversationId &&
        UUID.test(entry.lastIdleTransition.eventId?.split(":")[0] ?? "")
        ? entry.lastIdleTransition.eventId!.split(":")[0]!
        : known?.browserSessionId ?? known?.sessionId ?? entry.id);
    const observedAt = Date.parse(entry.statusObservedAt ?? "");
    return {
      id: entry.bootstrapIdentity?.publicId ?? entry.publicSessionId ?? entry.id,
      browserSessionId,
      idleSequence: entry.lastIdleTransition?.conversationId === conversationId &&
        Number.isSafeInteger(entry.lastIdleTransition.sequence)
          ? Math.max(0, entry.lastIdleTransition.sequence ?? 0) : 0,
      activity: entry.activity, status: entry.status, lastRole: entry.lastRole,
      working: Number.isFinite(observedAt) && observedAt <= Date.now() + 1000 &&
        Date.now() - observedAt < 15_000 &&
        (entry.activity === "working" || entry.status === "working"),
    };
  }

  private async registered(sessionId: string, conversationId: string) {
    const roster = await this.loadRoster();
    return roster ? this.bindingInRoster(roster, sessionId, conversationId) : null;
  }

  private async read(sessionId: string, conversationId: string) {
    const response = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "read",
      sessionId, expectedConversationId: conversationId, count: 1,
    });
    return response.ok && "data" in response && response.data && typeof response.data === "object"
      ? response.data as Record<string, unknown> : null;
  }

  setTaskReservations(
    reservations: ReadonlyArray<{requestId: string; sessionId: string | null; holdUntil?: number}>,
    inventoryReady = true,
  ) {
    this.taskReservations = reservations.map(row => ({
      requestId: row.requestId,
      sessionId: row.sessionId,
      ...(row.holdUntil === undefined ? {} : { holdUntil: row.holdUntil }),
    }));
    this.taskBoardInventoryReady = inventoryReady;
  }

  private async nativeWorkingInventory(): Promise<{ ids: string[]; known: boolean }> {
    const cached = this.nativeCapacityCache;
    if (cached && Date.now() - cached.observedAt < 5_000)
      return { ids: cached.ids, known: cached.known };
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(), type: "t3.threads", action: "list",
    }).catch(() => null);
    const data = reply?.ok && "data" in reply && reply.data &&
      typeof reply.data === "object" ? reply.data as {
        environmentId?: string; threads?: Array<{ id?: string; status?: string }>;
      } : null;
    const known = !!data?.environmentId && Array.isArray(data.threads);
    const ids = known ? data.threads!.filter(thread =>
      typeof thread.id === "string" &&
      ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status ?? "")
    ).map(thread => nativeOwner(data.environmentId!, thread.id!)) : [];
    this.nativeCapacityCache = { observedAt: Date.now(), ids, known };
    return { ids, known };
  }

  async capacity(extraReserved = 0): Promise<{
    observedAt: string; limit: number; working: number; reserved: number;
    workingIds: string[]; unknown: number; used: number; available: number;
    admissible: boolean; reason: string | null;
  }> {
    this.expireTimedBusy();
    const policy = this.keepT3Busy;
    const now = Date.now();
    for (const [reporter, state] of this.workingReports)
      if (now - state.observedAt > 7_000) this.workingReports.delete(reporter);

    // Count only actual working agents, never queued messages or reservations.
    // The ChatGPT sidebar and native orchestration are distinct live inventories.
    const workingIds = new Set<string>();
    for (const report of this.workingReports.values())
      for (const id of report.ids) workingIds.add(id);
    const nativeInventory = await this.nativeWorkingInventory();
    for (const id of nativeInventory.ids) workingIds.add(id);
    const used = workingIds.size;
    const observed = {
      observedAt: new Date(now).toISOString(), limit: this.maxWorking,
      working: used, workingIds: [...workingIds], used,
      available: Math.max(0, this.maxWorking - used),
    };
    if (this.workingReports.size === 0 || !nativeInventory.known) return {
      ...observed, reserved: 0, unknown: 1, admissible: false,
      reason: this.workingReports.size === 0
        ? "Live ChatGPT sidebar green-session count unavailable"
        : "Native T3 working-thread inventory unavailable",
    };

    // Native + ChatGPT working threads contribute to the same cap.
    // Pending messages, TaskBoard reservations and startup attempts are not workers.
    return {
      ...observed, reserved: 0, unknown: 0,
      admissible: policy && used < this.maxWorking,
      reason: !policy ? "Keep T3 Busy disabled" :
        used >= this.maxWorking ? "At capacity" : null,
    };
  }
  /** Do not force a shutdown on a transient zero or stale observation.
   * Error/orange/red sessions are not working. Persist OFF before /s /f /t 0.
   * No fallback to guessed zero when the live header or inventory is missing. */
  private async checkShutdown(): Promise<void> {
    this.expireTimedBusy();
    if (!this.started || !this.shutdownWhenIdle || this.busyUntil !== null || this.shutdownChecking) return;
    this.shutdownChecking = true;
    try {
      const snapshot = await this.capacity();
      if (!this.started || !this.shutdownWhenIdle || this.busyUntil !== null) return;
      // A completed queued wake has a two-minute capacity cooldown; it is
      // *not* an active session and must not hold the PC awake indefinitely.
      // Only actual workers, active outbox attempts or pending starts matter.
      const sending = [...this.entries.values()].some(row => {
        if (row.paused || !row.pendingMessageId) return false;
        if (row.targetKind === "t3") return true;
        try {
          const status = this.deliveries.status(row.pendingMessageId).status;
          return status === "sending" || status === "uncertain" || status === "queued";
        } catch { return false; }
      });
      if (snapshot.unknown > 0 || snapshot.working > 0 || sending ||
          this.taskReservations.length > 0 || !this.taskBoardInventoryReady) {
        this.shutdownIdleSince = null;
        return;
      }
      const now = Date.now();
      if (this.shutdownIdleSince === null) {
        this.shutdownIdleSince = now;
        return;
      }
      if (now - this.shutdownIdleSince < 5 * 60_000) return;
      // Disarm durably BEFORE initiating /f. A failed OS call will remain off
      // rather than unexpectedly retry and terminate the user's later work.
      this.shutdownWhenIdle = false;
      this.shutdownIdleSince = null;
      this.save();
      try { this.shutdownPC(); }
      catch (error) {
        this.shutdownError = error instanceof Error ? error.message : String(error);
      }
    } catch {
      this.shutdownIdleSince = null;
    } finally {
      this.shutdownChecking = false;
    }
  }

  private async admissionExclusive<T>(check: () => Promise<T>): Promise<T> {
    const previous = this.admissionGate;
    let unlock!: () => void;
    this.admissionGate = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try { return await check(); }
    finally { unlock(); }
  }

  /** User-queued session-view messages outrank TaskBoard and automatic Caffy.
   * The queue is durable, so this also survives renderer/window restarts.
   */
  hasPriorityCapacityMessage(): boolean {
    return [...this.capacityClaims.values()].some(row => row.state === "waiting");
  }

  async capacityMessage(input: CapacityMessageRequest): Promise<CapacityMessageReceipt> {
    if (!UUID.test(input.messageId)) throw new Error("Invalid capacity message UUID");
    return await this.admissionExclusive(async () => {
      const messageId = input.messageId;
      const receipt = (status: CapacityMessageReceipt["status"], reason?: string): CapacityMessageReceipt =>
        ({ messageId, status, ...(reason ? {reason} : {}) });
      let claim = this.capacityClaims.get(messageId);
      if (input.action === "claim") {
        if (!UUID.test(input.sessionId) ||
            (input.conversationId !== null && !UUID.test(input.conversationId)))
          throw new Error("Invalid capacity claim identity.");
        // Historical Session-view messages may have a per-message OpenRig
        // limit. T3 ignores it; the global T3 limit is now the sole policy.
        if (claim && (claim.sessionId !== input.sessionId ||
            claim.conversationId !== input.conversationId))
          throw new Error("Capacity message UUID already belongs to another session.");
        if (!claim) {
          claim = {
            messageId, sessionId: input.sessionId,
            conversationId: input.conversationId,
            state: "waiting", createdAt: Date.now(), submittedAt: null,
          };
          this.capacityClaims.set(messageId, claim);
          this.save();
        }
      }
      if (!claim) return receipt("unavailable", "No durable T3 capacity message with this ID.");
      if (input.action === "release") {
        if (input.reason === "pre_submit_aborted" &&
            (claim.state === "waiting" || claim.state === "admitted")) {
          this.capacityClaims.delete(messageId); this.save();
          return receipt("released");
        }
        if (input.reason !== "assistant_idle_verified" ||
            !["submitted", "uncertain"].includes(claim.state) ||
            claim.submittedAt === null)
          return receipt("held", "Capacity lease may have been submitted; exact post-submit idle proof is required.");
        const response = await this.request({
          version: 1, requestId: NodeCrypto.randomUUID(), type: "chatgpt.sessions",
          action: "list", which: "all", includeHidden: true,
        }).catch(() => null);
        const data = response?.ok && "data" in response && response.data &&
          typeof response.data === "object" ? response.data as {
            sessions?: Array<{
              id?: string; conversationId?: string; activity?: string; status?: string;
              statusObservedAt?: string; lastRole?: string;
            }>; hasMore?: boolean; incomplete?: boolean;
          } : null;
        const session = !data?.hasMore && !data?.incomplete
          ? data?.sessions?.find(row => row.id === claim.sessionId) : null;
        const observed = Date.parse(session?.statusObservedAt ?? "");
        if (!session || session.activity !== "idle" ||
            !["done_or_idle", "waiting_for_input"].includes(session.status ?? "") ||
            session.lastRole !== "assistant" ||
            (claim.conversationId && claim.conversationId !== session.conversationId) ||
            !Number.isFinite(observed) || observed <= claim.submittedAt ||
            observed > Date.now() + 1000 || Date.now() - observed > 15_000)
          return receipt("held", "Awaiting verified assistant idle in the exact conversation.");
        this.capacityClaims.delete(messageId); this.save();
        return receipt("released");
      }
      if (input.action === "submit") {
        if (claim.state === "submitted") return receipt("submitted");
        if (claim.state !== "admitted") return receipt("held", "This message has not been admitted.");
        claim.state = "submitted"; claim.submittedAt = Date.now(); this.save();
        return receipt("submitted");
      }
      if (input.action === "uncertain") {
        if (claim.state === "submitted" || claim.state === "admitted") {
          claim.state = "uncertain"; this.save();
        }
        return receipt("uncertain");
      }
      if (claim.state === "admitted" || claim.state === "submitted" || claim.state === "uncertain")
        return receipt(claim.state === "admitted" ? "admitted" :
          claim.state === "submitted" ? "submitted" : "uncertain");
      if (input.action === "status") return receipt("waiting");
      // FIFO: once an older user's message is queued, other capacity requests
      // cannot jump ahead, and no TaskBoard/Caffy admission can race this gate.
      const oldest = [...this.capacityClaims.values()]
        .filter(row => row.state === "waiting")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest !== claim) return receipt("waiting", "An earlier user message has priority.");
      if ([...this.capacityClaims.values()].some(row =>
        row.messageId !== claim.messageId && row.sessionId === claim.sessionId &&
        row.state !== "waiting"))
        return receipt("waiting", "Another message is already using this session.");
      const snapshot = await this.capacity().catch(() => null);
      if (!snapshot || snapshot.unknown !== 0 ||
          snapshot.used + snapshot.reserved >= snapshot.limit)
        return receipt("waiting", snapshot?.reason ?? "Waiting for T3 capacity.");
      claim.state = "admitted"; this.save();
      return receipt("admitted");
    });
  }

  /** TaskBoard and Caffy share a single atomic gate, not separate racy reads.
   * For an already-held queued session, a continuation reuses its existing slot.
   */
  async acquireAutomaticAdmission(
    ticket: string, sessionId?: string, allowWhenBusyDisabled = false,
    target?: string,
  ): Promise<boolean> {
    return await this.admissionExclusive(async () => {
      this.expireTimedBusy();
      const alreadyHeld = !!sessionId && (
        this.taskReservations.some(row => row.sessionId === sessionId &&
          row.holdUntil !== undefined && row.holdUntil > Date.now()) ||
        [...this.entries.values()].some(row => row.sessionId === sessionId &&
          row.pendingMessageId !== null));
      const available = await this.capacity().catch(() => null);
      const reason = !this.keepT3Busy && !allowWhenBusyDisabled ? "Keep T3 Busy disabled" :
        !available || available.unknown !== 0
          ? available?.reason ?? "Capacity inventory unavailable" :
        available.used >= available.limit
          ? available.reason ?? "At capacity" :
        null;
      this.automaticAdmissionJournal.record({
        ticket, ...(target ? { target } : {}), alreadyHeld,
        decision: reason ? "deferred" : "admitted",
        reason: reason ?? (alreadyHeld ? "Existing pending slot" : "Capacity available"),
        capacity: available,
      });
      if (reason) return false;
      if (!alreadyHeld) this.automaticAdmissions.add(ticket);
      return true;
    });
  }

  releaseAutomaticAdmission(ticket: string): void {
    if (this.automaticAdmissions.delete(ticket))
      this.automaticAdmissionJournal.released(ticket);
  }

  get policyEnabled(): boolean { this.expireTimedBusy(); return this.keepT3Busy; }
  throughputStatus() { this.expireTimedBusy(); return this.throughput.snapshot(); }

  /**
   * TaskBoard yields to waiting slot-respecting Caffy recipients, including unloaded
   * ChatGPT pages, before it can claim another automatic worker slot.
   * Invalid bindings are excluded once their reconciliation error is known.
   */
  get hasPendingQueuedWakes(): boolean {
    this.expireTimedBusy();
    const now = Date.now();
    return (
      [...this.scheduledSpawns.values()].some(job => job.status === "scheduled" &&
        (job.onIdle === true || (job.beginAt !== null && job.beginAt <= now))) ||
      [...this.entries.values()].some(row =>
        row.respectSlots && row.pendingWake && !row.paused &&
        !row.pendingMessageId && row.lastError === null &&
        // A queued wake intentionally delayed by the user does not reserve
        // priority/capacity until its activation deadline.
        (row.beginAt == null || row.beginAt <= now) &&
        (row.expiresAt === null || row.expiresAt > now)) ||
      [...this.entries.values()].some(row => row.delayedPrompt && row.pendingWake &&
        !row.paused && (row.beginAt === null || row.beginAt === undefined || row.beginAt <= now)));
  }

  private async pump() {
    this.expireTimedBusy();
    if (!this.started) return;
    if (this.pumping) { this.pumpRequested = true; return; }
    this.pumping = true;
    try {
      await this.reconcileIdentityAliases().catch(() => {});
      const now = Date.now();
      await this.dispatchScheduledSpawn(now);
      await this.activateCreatedSpawnCaffy();
      const rows = [...this.entries.values()].sort((a,b) =>
        Number(b.respectSlots && b.pendingWake && !b.paused) -
        Number(a.respectSlots && a.pendingWake && !a.paused));
      for (const row of rows) {
        if (this.entries.get(row.sessionId) !== row) continue;
        if (row.rebootOperationId) {
          await this.reconcileReboot(row).catch(() => {});
          continue;
        }
        if (row.beginAt !== undefined && row.beginAt !== null) {
          if (now < row.beginAt) continue;
          row.beginAt = null;
          row.pendingWake = true;
          row.pendingReason = "manual";
          this.save();
        }
        if (row.expiresAt !== null && row.expiresAt <= now && !row.pendingMessageId) {
          this.entries.delete(row.sessionId);
          this.save();
          continue;
        }
        if (row.targetKind === "t3") {
          await this.pumpNative(row, now);
          continue;
        }
        if (row.pendingMessageId) {
          try {
            this.onDelivery(this.deliveries.status(row.pendingMessageId));
          } catch {
            // Crash between persisting the ID and enqueuing it: reuse that ID.
            try {
              this.deliveries.enqueue({
                messageId: row.pendingMessageId, sessionId: row.sessionId,
                conversationId: row.conversationId, body: row.pendingMessageBody ?? WAKE_TEXT,
                caffyWake: true,
              });
            } catch (error) { row.lastError = String(error); this.save(); }
          }
          continue;
        }
        if (row.paused) continue;
        const due = reduceCaffyWake(row, { type: "due", now });
        if (Object.keys(due.patch).length) {
          this.applyWakeTransition(row, due.patch);
          this.save();
        }
        if (!row.pendingWake) continue;
        if (this.legacyConflict(row.sessionId, row.conversationId)) {
          row.paused = true;
          row.lastError = "Legacy OmniHub monitor owns this session; T3 Caffy suspended to avoid duplicate waking.";
          this.save();
          continue;
        }
        const wakeTicket = `wake:${row.sessionId}:${row.conversationId}`;
        const bypassCapacity = !row.respectSlots;
        if (!bypassCapacity && !(await this.acquireAutomaticAdmission(
          wakeTicket, row.sessionId, true,
        ))) {
          row.admissionReason = "Waiting for available capacity / admission inventory.";
          this.save();
          continue;
        }
        row.admissionReason = null;
        try {
        // Do not gate queued work on a separate roster lookup. The delivery
        // queue verifies the exact conversation and safe idle before sending;
        // an unavailable or stale roster must not prevent trying that path.
        if (this.entries.get(row.sessionId) !== row || row.paused) continue;
        const rebootAnchor = row.lastRebootAt ?? row.createdAt;
        if (!row.onceOnly && ((row.autoRebootMinutes &&
            now - rebootAnchor >= row.autoRebootMinutes * 60_000) ||
            (row.autoRebootEveryRuns && (row.wakesSinceReboot ?? 0) >= row.autoRebootEveryRuns))) {
          await this.beginAutoReboot(row);
          continue;
        }
        if (row.lastError) { row.lastError = null; this.save(); }
        // Persist the exact stable message ID before enqueue; an ambiguous
        // result is reconciled by this ID rather than generating another wake.
        const messageId = NodeCrypto.randomUUID();
        const claimed = reduceCaffyWake(row, {
          type: "claim", messageId, body: row.delayedPrompt ?? row.repeatPrompt ?? WAKE_TEXT,
          now: Date.now(),
        });
        if (!Object.keys(claimed.patch).length) continue;
        this.applyWakeTransition(row, claimed.patch);
        this.save();
        try {
          this.deliveries.enqueue({
            messageId, sessionId: row.sessionId,
            conversationId: row.conversationId, body: row.pendingMessageBody ?? WAKE_TEXT,
            caffyWake: true,
          });
        } catch (error) {
          // Keep the ID pinned; the journal might already contain it.
          row.lastError = String(error);
          this.save();
        }
        } finally {
          if (!bypassCapacity) this.releaseAutomaticAdmission(wakeTicket);
        }
      }
    } finally {
      this.pumping = false;
      this.syncPower();
      if (this.pumpRequested) {
        this.pumpRequested = false;
        queueMicrotask(() => { void this.pump(); });
      }
    }
  }
}
