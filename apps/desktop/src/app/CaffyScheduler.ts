// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- T3 owns local durable timers and power requests.
// T3-owned Caffy. No OpenRig or OmniHub scheduler dependency.
import * as NodeCrypto from "node:crypto";
import * as NodeCP from "node:child_process";
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

type Mode = "idle" | "periodic" | "queued" | "startup";
type Trigger = "idle" | "periodic" | "queued" | "startup" | "manual";
type Request = (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
export interface CaffyConfig {
  sessionId: string;
  browserSessionId?: string | undefined;
  /** Public Bootstrap / T3_ID alias; never use as the delivery target unless it is the browser ID. */
  publicSessionId?: string | undefined;
  conversationId: string;
  mode: Mode;
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
  lastWakeAt: number | null;
  lastError: string | null;
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
  /** An admitted queued monitor retains one automatic slot until stopped. */
  capacityHeld?: boolean;
  /** One-time clock-based prompt can run even when automatic TaskBoard work is disabled. */
  runWithoutBusy?: boolean;
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
interface ScheduledChatGPTSpawn {
  id: string;
  title: string;
  prompt: string;
  beginAt: number | null;
  /** Wait for Keep T3 Busy to have a free agent slot, ahead of TaskBoard. */
  onIdle?: boolean;
  project?: string;
  status: "scheduled" | "dispatching" | "created" | "uncertain";
  /** Short reservation while the newly spawned session mounts and starts. */
  holdUntil?: number;
  sessionId?: string;
  error?: string;
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
const CLOCK = 10_000;
const valid = (row: CaffyConfig): boolean =>
  !!row && UUID.test(row.sessionId) && UUID.test(row.conversationId) &&
  ["idle", "periodic", "queued", "startup"].includes(row.mode) &&
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
  private keepT3Busy = false;
  private maxWorking = 6;
  private shutdownWhenIdle = false;
  private busyUntil: number | null = null;
  private shutdownIdleSince: number | null = null;
  private shutdownChecking = false;
  private shutdownError: string | null = null;
  private readonly shutdownPC: () => void;
  private readonly workingReports = new Map<string, { observedAt: number; ids: Set<string> }>();
  private readonly automaticAdmissions = new Set<string>();
  private readonly capacityClaims = new Map<string, LocalCapacityClaim>();
  private admissionGate: Promise<void> = Promise.resolve();
  private taskReservations: Array<{requestId: string; sessionId: string | null; holdUntil?: number}> = [];
  private taskBoardInventoryReady = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private pumpRequested = false;
  private lastIdentityReconcileAt = 0;
  private readonly missingSessions = new Map<string, {firstSeenAt: number; misses: number}>();
  /** A startup inventory may be temporarily empty or partially hydrated.
   * Only retire an absent recipient after we observed that exact session in
   * this process, or after an explicit close/missing-delivery receipt. */
  private readonly observedLifecycleIds = new Set<string>();
  private blockerId: number | null = null;
  private readonly deliveries: ChatGPTDeliveryQueue;
  private readonly request: Request;
  private readonly power: { start: () => number; stop: (id: number) => void };

  constructor(
    stateDir: string,
    deliveries: ChatGPTDeliveryQueue,
    request: Request,
    power: { start: () => number; stop: (id: number) => void },
    shutdownPC: () => void = () => {
      if (process.platform !== "win32")
        throw new Error("Forced shutdown supported only on Windows.");
      // /f forcibly closes unsaved apps; /t 0 requests immediate poweroff.
      const result = NodeCP.spawnSync("shutdown.exe", ["/s", "/f", "/t", "0"], {
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
        for (const row of saved.entries) if (valid(row)) {
          // Old idle monitors now share the same capacity-aware admission as queued work.
          if (row.mode === "idle") {
            row.runWithoutBusy = row.onceOnly && row.beginAt != null;
            row.mode = "queued";
          }
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
      if (!row || row.pendingMessageId !== record.messageId) return true;
      // Keep T3 Busy controls only TaskBoard autofill. User-created Caffy
      // schedules remain eligible even when TaskBoard autofill is off.
      return !row.paused;
    });
    this.deliveries.setDispatchAdmission(async record => {
      const row = this.lookup(record.sessionId);
      if (!row || row.pendingMessageId !== record.messageId) return true;
      if (row.paused) return false;
      const snapshot = await this.capacity().catch(() => null);
      // An already admitted wake may finish its exact pending send, but a
      // preexisting oversubscription must not authorize additional Caffy
      // activations. TaskBoard and Caffy use the same global cap.
      return snapshot?.unknown === 0 &&
        snapshot.used + snapshot.reserved <= snapshot.limit;
    });
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

  private save() {
    const tmp = this.file + "." + process.pid + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify({
        version: 2, entries: [...this.entries.values()],
        scheduledSpawns: [...this.scheduledSpawns.values()],
        capacityClaims: [...this.capacityClaims.values()],
        agentStops: [...this.agentStops.values()].slice(-128),
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

  start() {
    if (this.started) return;
    this.started = true;
    this.expireTimedBusy();
    this.backupConfiguration();
    let changed = false;
    for (const row of this.entries.values()) {
      if (this.legacyConflict(row.sessionId, row.conversationId)) {
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
    }
    if (changed) this.save();
    this.syncPower();
    this.timer = setInterval(() => { this.expireTimedBusy(); this.throughput.heartbeat(); void this.pump(); void this.checkShutdown(); }, CLOCK);
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
        row.browserSessionId === sessionId || row.publicSessionId === sessionId);
  }

  /**
   * T3's session roster may switch from the original browser UUID to the
   * Bootstrap public T3_ID after a chat initializes. Keep the original
   * browser ID as delivery identity, while accepting either ID for control.
   *
   * Never infer an alias from the conversation alone: registered() requires
   * the exact ID or the verified idle event's original browser-ID prefix.
   */
  async reconcileIdentityAliases(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastIdentityReconcileAt < 30_000) return;
    this.lastIdentityReconcileAt = now;
    let changed = false;
    for (const row of [...this.entries.values()]) {
      if (row.rebootOperationId) {
        await this.reconcileReboot(row).catch(() => {});
        continue;
      }
      const binding = await this.registered(row.sessionId, row.conversationId).catch(() => null);
      if (!binding) continue;
      if (binding.working && !row.lastActivatedAt) {
        row.lastActivatedAt = Date.now();
        changed = true;
      }
      if (row.publicSessionId !== binding.id) {
        row.publicSessionId = binding.id;
        changed = true;
      }
      if (row.browserSessionId !== binding.browserSessionId &&
          UUID.test(binding.browserSessionId) && !row.pendingMessageId &&
          !this.entries.has(binding.browserSessionId)) {
        // A not-yet-enqueued monitor can safely adopt the verified recipient.
        // In-flight UNKNOWN deliveries must retain their exact old identity.
        this.observedLifecycleIds.delete(row.sessionId);
        this.missingSessions.delete(row.sessionId);
        this.entries.delete(row.sessionId);
        row.sessionId = binding.browserSessionId;
        row.browserSessionId = binding.browserSessionId;
        this.entries.set(row.sessionId, row);
        changed = true;
      }
    }
    if (changed) this.save();
    await this.reconcileLifecycle();
  }

  /**
   * A normal unloaded guest remains in T3's persisted catalog, so only a
   * *complete* inventory can prove removal. Two misses 30s apart avoid
   * erasing valid monitors during renderer hydration/recovery.
   */
  async reconcileLifecycle(): Promise<void> {
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    }).catch(() => null);
    const data = reply?.ok && "data" in reply && reply.data &&
      typeof reply.data === "object" ? reply.data as {
        sessions?: Array<{
          id?: string; publicSessionId?: string; browserSessionId?: string;
          conversationId?: string; bootstrapIdentity?: {
            state?: string; publicId?: string; conversationId?: string;
          };
          lastIdleTransition?: {eventId?: string; conversationId?: string; sequence?: number};
          hidden?: boolean; snoozedUntil?: number; closedAt?: unknown;
        }>; total?: number; hasMore?: boolean; incomplete?: boolean;
      } : null;
    const entries = data?.sessions;
    if (!Array.isArray(entries) || data?.hasMore || data?.incomplete ||
        data?.total === undefined || data.total !== entries.length) return;
    const now = Date.now();
    for (const row of [...this.entries.values()]) {
      const ids = [row.sessionId, row.browserSessionId, row.publicSessionId]
        .filter((id): id is string => !!id);
      // Existence is a property of the stable T3 session, NOT its current
      // conversation. Reboots and restored tabs may change conversation IDs
      // while the Caffy schedule (including its delayed start) must survive.
      const matches = entries.filter(entry =>
        [entry.id, entry.browserSessionId, entry.publicSessionId,
          entry.bootstrapIdentity?.publicId,
          entry.lastIdleTransition?.eventId?.split(":")[0],
        ].some(id => id && ids.includes(id)));
      const key = row.sessionId;
      if (matches.length > 1) { this.missingSessions.delete(key); continue; }
      const found = matches[0];
      if (found) {
        this.observedLifecycleIds.add(key);
        this.missingSessions.delete(key);
        if (found.closedAt != null || found.hidden ||
            (typeof found.snoozedUntil === "number" && found.snoozedUntil > now)) {
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
          ? await this.read(found.id, nextId).catch(() => null) : null;
        const verified = registeredNew ||
          (proof?.conversationGuardValidated === true &&
            proof.verifiedConversationId === nextId);
        if (this.entries.get(row.sessionId) !== row) continue;
        if (!verified) {
          const detail = "Session switched conversations; Caffy retained until the new conversation is verified.";
          if (row.lastError !== detail) { row.lastError = detail; this.save(); }
          continue;
        }
        const oldConversationId = row.conversationId;
        // Retire the old conversation's wake before switching identities.
        // Clear the pending ID first: its cancelled receipt must not remove
        // this still-active Caffy monitor through onDelivery().
        row.pendingMessageId = null;
        this.deliveries.retireRecipient(ids, oldConversationId,
          "Caffy session migrated to a verified new conversation.", true);
        row.conversationId = nextId;
        row.lastIdleSequence =
          found.lastIdleTransition?.conversationId === nextId
            ? found.lastIdleTransition.sequence ?? 0 : 0;
        row.lastWakeAt = null;
        row.lastActivatedAt = now;
        row.lastRebootAt = now;
        row.lastError = null;
        this.save();
        continue;
      }
      // A cold session list can be reported as complete before the browser
      // catalog hydrates. Never erase a persisted monitor on that evidence.
      if (!this.observedLifecycleIds.has(key)) continue;
      const previous = this.missingSessions.get(key);
      if (previous && previous.misses >= 1 && now - previous.firstSeenAt >= 30_000)
        this.retire(row.sessionId, "missing");
      else this.missingSessions.set(key, {
        firstSeenAt: previous?.firstSeenAt ?? now, misses: (previous?.misses ?? 0) + 1,
      });
    }
  }

  status(sessionId?: string) {
    this.expireTimedBusy();
    if (sessionId) return this.lookup(sessionId) ?? null;
    return {
      entries: [...this.entries.values()],
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

  async set(input: {
    sessionId: string; conversationId: string; mode: Mode;
    durationMinutes?: number | undefined; onceOnly?: boolean | undefined; startup?: boolean | undefined;
    intervalMinutes?: number | undefined; keepAwake?: boolean | undefined;
    beginAt?: number | null | undefined;
    delayedPrompt?: string | null | undefined;
    repeatPrompt?: string | undefined;
    autoRebootMinutes?: number | null | undefined;
    autoRebootEveryRuns?: number | null | undefined;
  }) {
    if (!UUID.test(input.sessionId) || !UUID.test(input.conversationId))
      throw new Error("Exact sessionId and conversationId UUIDs required.");
    if (!["idle", "periodic", "queued", "startup"].includes(input.mode))
      throw new Error("Caffy mode must be idle, periodic, queued or startup.");
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
    // A cold/errored guest can still be scheduled using T3's exact persisted
    // session binding. The actual delivery always requires a fresh guarded read.
    const identity = await this.registered(input.sessionId, input.conversationId).catch(() => null);
    if (!identity) {
      const observed = await this.read(input.sessionId, input.conversationId).catch(() => null);
      if (!(observed?.conversationGuardValidated === true &&
            observed.verifiedConversationId === input.conversationId))
        throw new Error("T3 could not confirm the session/conversation binding. No schedule created.");
    }
    const browserSessionId = identity?.browserSessionId ?? input.sessionId;
    const canonicalId = browserSessionId;
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
    const prior = this.lookup(input.sessionId) ??
      [...this.entries.values()].find(row => row.conversationId === input.conversationId);
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
    const mode = input.mode === "idle" ? "queued" : input.mode;
    const same = !!prior && prior.conversationId === input.conversationId &&
      prior.mode === mode && prior.expiresAt ===
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
      if (prior.paused) {
        prior.paused = false;
        prior.lastError = null;
        this.save();
        this.backupConfiguration();
        void this.pump();
      }
      return prior;
    }
    const row: CaffyConfig = {
      sessionId: canonicalId, browserSessionId,
      publicSessionId: identity?.id ?? prior?.publicSessionId,
      conversationId: input.conversationId,
      mode, intervalMinutes,
      startup: mode === "startup" ? true : input.startup ?? false, onceOnly: input.onceOnly ?? false,
      keepAwake: input.keepAwake ?? true, paused: false, createdAt: now,
      expiresAt: input.durationMinutes === undefined ? null :
        Math.max(now, input.beginAt ?? prior?.beginAt ?? now) + input.durationMinutes * 60_000,
      nextDueAt: mode === "periodic" ? input.beginAt ?? now + intervalMinutes * 60_000 : null,
      pendingWake: mode === "queued" ? true : false,
      pendingReason: mode === "queued" ? "manual" : null,
      pendingMessageId: prior?.conversationId === input.conversationId ? prior.pendingMessageId : null,
      lastIdleSequence: Math.max(prior?.lastIdleSequence ?? 0, identity?.idleSequence ?? 0),
      lastWakeAt: prior?.lastWakeAt ?? null, lastError: null,
      beginAt: input.beginAt !== undefined ? input.beginAt : prior?.beginAt ?? null,
      delayedPrompt: input.delayedPrompt !== undefined ? input.delayedPrompt : prior?.delayedPrompt ?? null,
      repeatPrompt: input.repeatPrompt !== undefined ? input.repeatPrompt.trim() || null : prior?.repeatPrompt ?? null,
      pendingMessageBody: prior?.pendingMessageBody ?? null,
      autoRebootMinutes: input.autoRebootMinutes !== undefined ? input.autoRebootMinutes : prior?.autoRebootMinutes ?? null,
      autoRebootEveryRuns: input.autoRebootEveryRuns !== undefined ? input.autoRebootEveryRuns : prior?.autoRebootEveryRuns ?? null,
      wakesSinceReboot: prior?.wakesSinceReboot ?? 0,
      lastCountedWakeAt: prior?.lastCountedWakeAt ?? null,
      capacityHeld: mode === "queued" ? (prior?.capacityHeld ?? false) : false,
      runWithoutBusy: input.mode === "idle" && input.onceOnly === true && input.beginAt != null,
      lastActivatedAt: prior?.lastActivatedAt ?? null,
      lastRebootAt: prior?.lastRebootAt ?? null,
      rebootOperationId: prior?.rebootOperationId ?? null,
      rebootOldConversationId: prior?.rebootOldConversationId ?? null,
    };
    if (prior && prior.sessionId !== row.sessionId) this.entries.delete(prior.sessionId);
    this.entries.set(row.sessionId, row);
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
    const cancelled = this.deliveries.retireRecipient(ids, row?.conversationId ?? null,
      detail, reason === "snoozed" || reason === "hidden" || reason === "stopped");
    if (row) {
      this.missingSessions.delete(row.sessionId);
      this.observedLifecycleIds.delete(row.sessionId);
      this.save();
    }
    return { stopped: !!row, cancelled };
  }

  stop(sessionId: string, initiator: "user" | "agent" = "agent") {
    const { stopped } = this.retire(sessionId, "stopped", initiator);
    return { stopped };
  }

  scheduleSpawn(input: { id: string; title: string; prompt: string; beginAt: number | null; onIdle?: boolean; project?: string }) {
    if (!UUID.test(input.id)) throw new Error("Scheduled job requires a stable UUID.");
    if (!input.title.trim() || input.title.length > 120 ||
        !input.prompt.trim() || input.prompt.length > 29_800)
      throw new Error("Provide a title and a prompt (maximum 29800 characters).");
    if (input.onIdle === true ? input.beginAt !== null :
        input.beginAt === null || !Number.isSafeInteger(input.beginAt) ||
        input.beginAt <= Date.now() || input.beginAt > Date.now() + 90 * 24 * 60 * 60_000)
      throw new Error("Choose either the next available agent slot or a future time within 90 days.");
    const existing = this.scheduledSpawns.get(input.id);
    if (existing) {
      if (existing.title !== input.title || existing.prompt !== input.prompt ||
          existing.beginAt !== input.beginAt ||
          (existing.onIdle === true) !== (input.onIdle === true) ||
          existing.project !== input.project)
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
  updateScheduledSpawn(input: { id: string; title: string; prompt: string; beginAt: number | null; onIdle?: boolean }) {
    const job = this.readScheduledSpawn(input.id);
    if (!input.title.trim() || input.title.length > 120 ||
        !input.prompt.trim() || input.prompt.length > 29_800)
      throw new Error("Provide a prompt (maximum 29800 characters).");
    const now = Date.now();
    if (input.onIdle === true ? input.beginAt !== null :
        input.beginAt === null || !Number.isSafeInteger(input.beginAt) ||
        (input.beginAt <= now && input.beginAt !== job.beginAt) ||
        input.beginAt > now + 90 * 24 * 60 * 60_000)
      throw new Error("Choose a future start within 90 days, or the next available agent slot.");
    this.scheduledSpawns.set(job.id, {
      ...job, title: input.title.trim(), prompt: input.prompt.trim(),
      beginAt: input.beginAt, onIdle: input.onIdle === true,
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
      const delivery = this.deliveries.status(messageId);
      if (delivery.status !== "queued")
        throw new Error("Prompt may already have been sent; inspect delivery before cancelling.");
      row.pendingMessageId = null;
      row.pendingMessageBody = null;
      this.deliveries.cancel(messageId);
    }
    if (row.onceOnly && (row.mode === "queued" || row.mode === "idle")) {
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

  async beginAt(sessionId: string, conversationId: string, at: number | null, prompt?: string) {
    if (prompt !== undefined && (!prompt.trim() || prompt.length > 29_800))
      throw new Error("Delayed prompt must contain 1..29800 characters.");
    if (at !== null && (!Number.isSafeInteger(at) || at <= Date.now() ||
        at > Date.now() + 90 * 24 * 60 * 60_000))
      throw new Error("Begin working must be within the next 90 days.");
    let row = this.lookup(sessionId);
    if (!row) {
      if (at === null) return { cleared: true };
      row = await this.set({ sessionId, conversationId, mode: "queued",
        onceOnly: true, keepAwake: false, beginAt: at, delayedPrompt: prompt ?? null });
      row.runWithoutBusy = true;
      this.save();
      return row;
    }
    if (row.conversationId !== conversationId)
      throw new Error("Delayed start requires the same registered conversation.");
    if (row.rebootOperationId) throw new Error("A reboot is awaiting reconciliation.");
    if (at !== null && this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor owns this session; cannot resume T3 Caffy.");
    if (at === null && row.onceOnly && row.mode === "idle" &&
        row.beginAt !== null && row.beginAt !== undefined && row.lastWakeAt === null) {
      return { cleared: true, stopped: this.stop(sessionId).stopped };
    }
    if (row.pendingMessageId) {
      // Delay cannot retract an UNKNOWN or already submitted wake.
      const previous = this.deliveries.status(row.pendingMessageId);
      if (previous.status !== "queued")
        throw new Error("Cannot delay a wake that has already been attempted.");
      const messageId = row.pendingMessageId;
      row.pendingMessageId = null;
      row.pendingMessageBody = null;
      this.deliveries.cancel(messageId);
    }
    if (row.expiresAt !== null) {
      const base = row.beginAt ?? row.createdAt;
      const duration = Math.max(60_000, row.expiresAt - base);
      row.expiresAt = (at ?? Date.now()) + duration;
    }
    row.beginAt = at;
    row.runWithoutBusy = at !== null;
    row.delayedPrompt = at === null ? null : prompt ?? null;
    row.pendingWake = true;
    row.pendingReason = "manual";
    if (at !== null) {
      // The renderer first pauses the live monitor while clicking Stop.
      // Persist the future deadline AND the resumed scheduler atomically, so
      // a lost follow-up IPC cannot leave Caffy permanently paused.
      row.paused = false;
      row.lastError = null;
    }
    this.save();
    this.backupConfiguration();
    if (at === null) void this.pump();
    return row;
  }

  autoReboot(sessionId: string, minutes: number | null, everyRuns: number | null = null) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("Configure Auto-continue before enabling auto-reboot.");
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
    const matches = (data.sessions ?? []).filter(entry =>
      entry.id === row.sessionId || entry.browserSessionId === row.browserSessionId ||
      entry.publicSessionId === row.publicSessionId ||
      entry.bootstrapIdentity?.publicId === row.publicSessionId);
    if (matches.length !== 1) return;
    const entry = matches[0]!;
    const nextId = entry.conversationId;
    if (!nextId || !UUID.test(nextId) || nextId === row.rebootOldConversationId ||
        entry.bootstrapIdentity?.conversationId !== nextId ||
        entry.bootstrapIdentity?.state !== "registered") return;
    row.conversationId = nextId;
    row.publicSessionId = entry.bootstrapIdentity.publicId ?? row.publicSessionId;
    row.lastIdleSequence = entry.lastIdleTransition?.conversationId === nextId
      ? entry.lastIdleTransition.sequence ?? 0 : 0;
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

  pause(sessionId: string, paused: boolean) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
    if (!paused && this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor still owns this session; cancel it before resuming T3 Caffy.");
    row.paused = paused;
    // Pausing relinquishes any automatic continuation lease unless a prompt
    // is already in-flight. On resume it must reacquire through the gate.
    if (paused && row.mode === "queued" && row.pendingMessageId === null)
      row.capacityHeld = false;
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
    if (this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor still owns this session; cancel it before waking.");
    row.pendingWake = true;
    row.pendingReason = "manual";
    this.save();
    void this.pump();
    return row;
  }

  onIdle(event: VerifiedChatGPTIdleTransition) {
    const row = this.lookup(event.sessionId) ??
      [...this.entries.values()].find(item =>
        item.conversationId === event.conversationId &&
        (event.eventId.startsWith(`${item.sessionId}:${event.conversationId}:`) ||
          (item.browserSessionId &&
            event.eventId.startsWith(`${item.browserSessionId}:${event.conversationId}:`))));
    if (!row || row.paused || row.conversationId !== event.conversationId ||
        event.sequence <= row.lastIdleSequence) return;
    row.lastIdleSequence = event.sequence;
    if (event.kind === "completed" && row.lastWakeAt !== null &&
        event.observedAt > row.lastWakeAt &&
        row.lastWakeAt > (row.lastCountedWakeAt ?? 0)) {
      row.wakesSinceReboot = (row.wakesSinceReboot ?? 0) + 1;
      row.lastCountedWakeAt = row.lastWakeAt;
    }
    if ((row.mode === "idle" || row.mode === "queued") &&
        !row.pendingMessageId && !row.rebootOperationId &&
        (row.beginAt === null || row.beginAt === undefined || row.beginAt <= Date.now())) {
      row.pendingWake = true;
      row.pendingReason = "idle";
    }
    this.save();
    void this.pump();
  }

  private onDelivery(record: Omit<DeliveryRecord, "body">) {
    const row = this.lookup(record.sessionId);
    if (!row || row.pendingMessageId !== record.messageId) return;
    if (record.status === "delivered") {
      row.pendingMessageId = null;
      row.pendingMessageBody = null;
      row.delayedPrompt = null;
      row.runWithoutBusy = false;
      row.lastWakeAt = Date.now();
      row.lastActivatedAt ??= row.lastWakeAt;
      row.lastError = null;
      if (row.onceOnly) { this.entries.delete(row.sessionId); }
    } else if (record.status === "cancelled") {
      // The recipient was removed, or a pending Caffy wake was cancelled.
      // A stopped monitor must never keep a phantom registration.
      this.entries.delete(row.sessionId);
    } else if (record.status === "needs_attention") {
      row.lastError = record.lastError ?? record.status;
      row.paused = true; // no unbounded speculative new message
    }
    this.save();
  }

  private async registered(sessionId: string, conversationId: string): Promise<{ id: string; browserSessionId: string; working: boolean; idleSequence: number } | null> {
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    }).catch(() => null);
    if (!reply?.ok || !("data" in reply) || !reply.data || typeof reply.data !== "object")
      return null;
    const entries = (reply.data as { sessions?: Array<{
      id?: string; publicSessionId?: string; browserSessionId?: string;
      conversationId?: string; bootstrapIdentity?: {conversationId?:string; publicId?:string};
      activity?: string; status?: string; statusObservedAt?: string;
      lastIdleTransition?: {conversationId?: string; sequence?: number; eventId?: string};
      closedAt?: unknown;
    }> }).sessions;
    if (!Array.isArray(entries)) return null;
    const known = this.lookup(sessionId);
    const matches = entries.filter(entry => {
      const idle = entry.lastIdleTransition;
      const observedBrowserId = idle?.conversationId === conversationId &&
        typeof idle.eventId === "string" && idle.eventId.includes(":")
          ? idle.eventId.split(":")[0] : null;
      return entry.id === sessionId || entry.browserSessionId === sessionId ||
        entry.publicSessionId === sessionId || entry.bootstrapIdentity?.publicId === sessionId ||
        observedBrowserId === sessionId ||
        (known?.publicSessionId !== undefined &&
          (entry.id === known.publicSessionId || entry.bootstrapIdentity?.publicId === known.publicSessionId));
    });
    const entry = matches.length === 1 ? matches[0] : null;
    return entry?.id && entry.closedAt == null &&
      // If the browser is visibly on another conversation, an older Bootstrap
      // marker cannot authorize a wake to its obsolete conversation ID.
      (entry.conversationId
        ? entry.conversationId === conversationId
        : entry.bootstrapIdentity?.conversationId === conversationId)
      ? {
          id: entry.bootstrapIdentity?.publicId ?? entry.publicSessionId ?? entry.id,
          // Bootstrap replaces the public ID; the renderer still mounts using
          // its original browser UUID embedded in the verified idle event.
          browserSessionId: entry.browserSessionId ??
            (entry.lastIdleTransition?.conversationId === conversationId &&
              UUID.test(entry.lastIdleTransition.eventId?.split(":")[0] ?? "")
              ? entry.lastIdleTransition.eventId!.split(":")[0]! :
                known?.browserSessionId ?? known?.sessionId ?? entry.id),
          idleSequence: entry.lastIdleTransition?.conversationId === conversationId &&
            Number.isSafeInteger(entry.lastIdleTransition.sequence)
            ? Math.max(0, entry.lastIdleTransition.sequence ?? 0) : 0,
          working: (() => {
            const observedAt = Date.parse(entry.statusObservedAt ?? "");
            return Number.isFinite(observedAt) && observedAt <= Date.now() + 1000 &&
              Date.now() - observedAt < 15_000 &&
              (entry.activity === "working" || entry.status === "working");
          })(),
        } : null;
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

    // Exactly the green rows reported by the ChatGPT list sidebar.
    // Neither TaskBoard ownership, Caffy monitors, startup reservations nor
    // the separately polled session registry may change the displayed usage.
    const workingIds = new Set<string>();
    for (const report of this.workingReports.values())
      for (const id of report.ids) workingIds.add(id);
    const used = workingIds.size;
    const observed = {
      observedAt: new Date(now).toISOString(), limit: this.maxWorking,
      working: used, workingIds: [...workingIds], used,
      available: Math.max(0, this.maxWorking - used),
    };
    if (this.workingReports.size === 0) return {
      ...observed, reserved: 0, unknown: 1, admissible: false,
      reason: "Live ChatGPT sidebar green-session count unavailable",
    };

    // Separate *admission protection* from capacity USAGE. Only pending
    // delivery/start attempts may temporarily withhold a future slot. A
    // TaskBoard task remaining Working while its agent is idle or unavailable
    // does not reserve capacity. Expired attempts must not block indefinitely.
    const pendingIds = new Set<string>();
    const pendingRequests = new Set<string>();
    let unboundPending = 0;
    for (const row of this.entries.values()) {
      // Paused Caffy configuration cannot autonomously start generation.
      // In particular an old failed/paused delivery isn't a phantom seat.
      if (!row.paused && row.pendingMessageId !== null)
        pendingIds.add(row.sessionId);
    }
    for (const claim of this.capacityClaims.values()) {
      if (claim.state !== "waiting") pendingIds.add(claim.sessionId);
    }
    for (const job of this.scheduledSpawns.values()) {
      if (job.status === "created" && job.sessionId && (job.holdUntil ?? 0) > now)
        pendingIds.add(job.sessionId);
    }
    for (const row of this.taskReservations) {
      if (row.holdUntil === undefined || row.holdUntil <= now) continue;
      pendingRequests.add(row.requestId);
      if (row.sessionId) pendingIds.add(row.sessionId);
      else unboundPending++;
    }
    for (const id of workingIds) pendingIds.delete(id);
    // The same new TaskBoard start is represented by its admission ticket
    // and its atomic TaskBoard reservation. Count it only once.
    const unpairedAdmissions = [...this.automaticAdmissions]
      .filter(ticket => !pendingRequests.has(ticket)).length;
    const reserved = pendingIds.size + unboundPending +
      extraReserved + unpairedAdmissions;
    const admissionUsed = used + reserved;
    if (!this.taskBoardInventoryReady) return {
      ...observed, reserved, unknown: 1, admissible: false,
      reason: "TaskBoard queue admission inventory unavailable",
    };
    return {
      ...observed, reserved, unknown: 0,
      admissible: policy && admissionUsed < this.maxWorking,
      reason: !policy ? "Keep T3 Busy disabled" :
        used >= this.maxWorking ? "At capacity" :
        admissionUsed >= this.maxWorking ? "Pending starts or deliveries" : null,
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
        try {
          const status = this.deliveries.status(row.pendingMessageId).status;
          return status === "sending" || status === "uncertain" || status === "queued";
        } catch { return true; } // UNKNOWN outbox outcome: fail closed.
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
      if (now - this.shutdownIdleSince < 30_000) return;
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
        !alreadyHeld && this.hasPriorityCapacityMessage() ? "User capacity message has priority" :
        !alreadyHeld && this.hasPendingQueuedWakes &&
          !ticket.startsWith("wake:") && !ticket.startsWith("scheduled-spawn:")
          ? "Existing queued wake has priority" :
        !available || available.unknown !== 0
          ? available?.reason ?? "Capacity inventory unavailable" :
        available.used + available.reserved >= available.limit + Number(alreadyHeld)
          ? available.reason ?? "At capacity" :
        this.automaticAdmissionJournal.delayMs > 0 ? "Automatic launch cooldown" : null;
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
   * TaskBoard yields to waiting queued Caffy recipients, including unloaded
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
        (row.mode === "queued" || row.mode === "periodic") && row.pendingWake && !row.paused &&
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
      const rows = [...this.entries.values()].sort((a,b) =>
        Number(b.mode === "queued" && b.pendingWake && !b.paused) -
        Number(a.mode === "queued" && a.pendingWake && !a.paused));
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
        if (row.mode === "periodic" && row.nextDueAt !== null && row.nextDueAt <= now) {
          const intervalMs = row.intervalMinutes * 60_000;
          // Preserve the original local-time cadence; coalesce missed runs into one.
          row.nextDueAt += (Math.floor((now - row.nextDueAt) / intervalMs) + 1) * intervalMs;
          row.pendingWake = true;
          row.pendingReason = "periodic";
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
        if (!(await this.acquireAutomaticAdmission(
          wakeTicket, row.sessionId, true,
        ))) continue;
        try {
        // A cold or errored session cannot pass a live guarded read until
        // it has been mounted. Enqueue from the exact registry binding so
        // the *existing* T3 delivery queue will mount/recover it. The guarded
        // send still refuses a working composer, draft or wrong conversation.
        const bound = await this.registered(row.sessionId, row.conversationId).catch(() => null);
        if (this.entries.get(row.sessionId) !== row || row.paused) continue;
        if (!bound) {
          // Reconciliation already identified this as the same live session
          // with a new conversation. Preserve the more actionable diagnostic,
          // and avoid rewriting the Caffy state every scheduler tick.
          if (row.lastError?.startsWith("Session switched conversations;")) continue;
          const reason = "T3 cannot verify this exact session and conversation; pending wake retained.";
          if (row.lastError !== reason) { row.lastError = reason; this.save(); }
          continue;
        }
        if (bound.working) {
          if (!row.lastActivatedAt) { row.lastActivatedAt = Date.now(); this.save(); }
          continue;
        }
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
        row.pendingMessageId = messageId;
        row.pendingMessageBody = row.delayedPrompt ?? row.repeatPrompt ?? WAKE_TEXT;
        row.delayedPrompt = null;
        row.pendingWake = false;
        row.pendingReason = null;
        if (row.mode === "queued") row.capacityHeld = true;
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
          this.releaseAutomaticAdmission(wakeTicket);
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
