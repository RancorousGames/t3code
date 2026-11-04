// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- T3 owns local durable timers and power requests.
// T3-owned Caffy. No OpenRig or OmniHub scheduler dependency.
import * as NodeCrypto from "node:crypto";
import * as NodeCP from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";
import type { ChatGPTDeliveryQueue, DeliveryRecord } from "./ChatGPTDeliveryQueue.ts";
import { sessionWorkCapacityIdentityResolver, type WorkCapacitySessionIdentity } from "./sessionWorkCapacityIdentity.ts";
import type { VerifiedChatGPTIdleTransition } from "./ChatGPTIdleTransitionJournal.ts";

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
  /** Only idle and queued modes support automated context reboot. */
  autoRebootMinutes?: number | null;
  /** First verified working observation or completed Caffy wake. */
  lastActivatedAt?: number | null;
  lastRebootAt?: number | null;
  /** Durable reboot operation ID; never allocate a second if outcome is UNKNOWN. */
  rebootOperationId?: string | null;
  rebootOldConversationId?: string | null;
}
interface CaffyStore { version: 2; entries: CaffyConfig[]; keepT3Busy: boolean; maxWorking: number; shutdownWhenIdle?: boolean }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const WAKE_TEXT = "Continue working on your current assignment. If everything is genuinely finished, stop Caffy for this session using the caffy tool (action=stop, sessionId=your T3_ID).";
const CLOCK = 10_000;
const valid = (row: CaffyConfig): boolean =>
  !!row && UUID.test(row.sessionId) && UUID.test(row.conversationId) &&
  ["idle", "periodic", "queued", "startup"].includes(row.mode) &&
  Number.isFinite(row.createdAt) && Number.isInteger(row.intervalMinutes) &&
  row.intervalMinutes >= 1 && row.intervalMinutes <= 60 &&
  (row.expiresAt === null || Number.isFinite(row.expiresAt)) &&
  (row.pendingMessageId === null || UUID.test(row.pendingMessageId));

/** One persistent policy and one pending message per session, regardless of wake source. */
export class CaffyScheduler {
  private readonly file: string;
  private readonly entries = new Map<string, CaffyConfig>();
  private keepT3Busy = false;
  private maxWorking = 6;
  private shutdownWhenIdle = false;
  private shutdownIdleSince: number | null = null;
  private shutdownChecking = false;
  private shutdownError: string | null = null;
  private readonly shutdownPC: () => void;
  private readonly workingReports = new Map<string, { observedAt: number; ids: Set<string> }>();
  private taskReservations: Array<{requestId: string; sessionId: string | null}> = [];
  private taskBoardInventoryReady = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private pumpRequested = false;
  private lastIdentityReconcileAt = 0;
  private readonly missingSessions = new Map<string, {firstSeenAt: number; misses: number}>();
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
    try {
      const saved = JSON.parse(NodeFS.readFileSync(this.file, "utf8")) as CaffyStore;
      if (saved.version === 2 && Array.isArray(saved.entries)) {
        for (const row of saved.entries) if (valid(row)) this.entries.set(row.sessionId, row);
        this.keepT3Busy = saved.keepT3Busy === true;
        this.shutdownWhenIdle = saved.shutdownWhenIdle === true;
        if (Number.isInteger(saved.maxWorking) && saved.maxWorking >= 1 && saved.maxWorking <= 100)
          this.maxWorking = saved.maxWorking;
      }
    } catch { /* Corrupt/missing local state is not evidence for a wake. */ }
    this.deliveries.subscribeTransitions(record => this.onDelivery(record));
    this.deliveries.setDispatchPermission(record => {
      const row = this.lookup(record.sessionId);
      if (!row || row.pendingMessageId !== record.messageId) return true;
      return !row.paused && (row.mode !== "queued" || this.keepT3Busy);
    });
    this.deliveries.setDispatchAdmission(async record => {
      const row = this.lookup(record.sessionId);
      if (!row || row.pendingMessageId !== record.messageId || row.mode !== "queued")
        return true;
      if (!this.keepT3Busy || row.paused) return false;
      const snapshot = await this.capacity().catch(() => null);
      // The outstanding queued wake already reserves one slot in 'used'.
      // A later manual spawn may exceed the capacity: defer without cancelling.
      return snapshot?.unknown === 0 && snapshot.used <= snapshot.limit;
    });
  }

  private save() {
    const tmp = this.file + "." + process.pid + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify({
        version: 2, entries: [...this.entries.values()],
        keepT3Busy: this.keepT3Busy, maxWorking: this.maxWorking,
        shutdownWhenIdle: this.shutdownWhenIdle,
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
        !["cancelled", "completed", "exhausted"].includes(monitor.state ?? "") &&
        (monitor.target?.sessionId === sessionId ||
         monitor.target?.expectedConversationId === conversationId));
    } catch { return false; }
  }

  private syncPower() {
    const active = [...this.entries.values()].some(row => !row.paused && row.keepAwake &&
      (row.mode !== "queued" || this.keepT3Busy) &&
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
    this.timer = setInterval(() => { void this.pump(); void this.checkShutdown(); }, CLOCK);
    this.timer.unref?.();
    void this.pump();
  }

  close() {
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
          conversationId?: string; bootstrapIdentity?: {publicId?: string; conversationId?: string};
          lastIdleTransition?: {eventId?: string; conversationId?: string};
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
      const matches = entries.filter(entry =>
        (row.rebootOperationId ||
          entry.conversationId === row.conversationId ||
          entry.bootstrapIdentity?.conversationId === row.conversationId) &&
        [entry.id, entry.browserSessionId, entry.publicSessionId,
          entry.bootstrapIdentity?.publicId,
          entry.lastIdleTransition?.conversationId === row.conversationId
            ? entry.lastIdleTransition.eventId?.split(":")[0] : undefined,
        ].some(id => id && ids.includes(id)));
      const key = `${row.sessionId}:${row.conversationId}`;
      if (matches.length > 1) { this.missingSessions.delete(key); continue; }
      const found = matches[0];
      if (found) {
        this.missingSessions.delete(key);
        if (found.closedAt != null || found.hidden ||
            (typeof found.snoozedUntil === "number" && found.snoozedUntil > now))
          this.retire(row.sessionId,
            found.closedAt != null ? "closed" : found.hidden ? "hidden" : "snoozed");
        continue;
      }
      const previous = this.missingSessions.get(key);
      if (previous && previous.misses >= 1 && now - previous.firstSeenAt >= 30_000)
        this.retire(row.sessionId, "missing");
      else this.missingSessions.set(key, {
        firstSeenAt: previous?.firstSeenAt ?? now, misses: (previous?.misses ?? 0) + 1,
      });
    }
  }

  status(sessionId?: string) {
    if (sessionId) return this.lookup(sessionId) ?? null;
    return {
      entries: [...this.entries.values()],
      keepT3Busy: this.keepT3Busy,
      maxWorking: this.maxWorking,
      shutdownWhenIdle: this.shutdownWhenIdle,
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

  policy(input: {
    keepT3Busy?: boolean | undefined;
    maxWorking?: number | undefined;
    shutdownWhenIdle?: boolean | undefined;
  }) {
    if (input.keepT3Busy !== undefined) this.keepT3Busy = input.keepT3Busy;
    if (input.shutdownWhenIdle !== undefined) {
      this.shutdownWhenIdle = input.shutdownWhenIdle;
      this.shutdownIdleSince = null;
      this.shutdownError = null;
    }
    if (input.maxWorking !== undefined) {
      if (!Number.isInteger(input.maxWorking) || input.maxWorking < 1 || input.maxWorking > 100)
        throw new Error("maxWorking must be 1..100.");
      this.maxWorking = input.maxWorking;
    }
    this.save();
    this.deliveries.resumeAllowed();
    void this.pump();
    return { keepT3Busy: this.keepT3Busy, maxWorking: this.maxWorking,
      shutdownWhenIdle: this.shutdownWhenIdle, shutdownError: this.shutdownError };
  }

  async set(input: {
    sessionId: string; conversationId: string; mode: Mode;
    durationMinutes?: number | undefined; onceOnly?: boolean | undefined; startup?: boolean | undefined;
    intervalMinutes?: number | undefined; keepAwake?: boolean | undefined;
    beginAt?: number | null | undefined;
  }) {
    if (!UUID.test(input.sessionId) || !UUID.test(input.conversationId))
      throw new Error("Exact sessionId and conversationId UUIDs required.");
    if (!["idle", "periodic", "queued", "startup"].includes(input.mode))
      throw new Error("Caffy mode must be idle, periodic, queued or startup.");
    if (input.durationMinutes !== undefined &&
        (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 10_080))
      throw new Error("Duration must be 1..10080 minutes or omitted for infinite.");
    if (input.mode === "startup" && input.startup === false)
      throw new Error("Startup-only Caffy requires startup=true.");
    if (["queued", "startup"].includes(input.mode) && input.durationMinutes !== undefined)
      throw new Error("Queued idle waking and startup-only are infinite; omit duration.");
    const intervalMinutes = input.intervalMinutes ?? 20;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60)
      throw new Error("Interval must be 1..60 minutes.");
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
    if (prior?.pendingMessageId &&
        (prior.conversationId !== input.conversationId || prior.sessionId !== canonicalId))
      throw new Error("Existing wake delivery needs reconciliation before changing its recipient identity.");
    const same = !!prior && prior.conversationId === input.conversationId &&
      prior.mode === input.mode && prior.expiresAt ===
        (input.durationMinutes === undefined ? null : prior.createdAt + input.durationMinutes * 60_000) &&
      prior.onceOnly === (input.onceOnly ?? false) &&
      prior.startup === (input.startup ?? (input.mode === "startup")) &&
      prior.keepAwake === (input.keepAwake ?? true) &&
      prior.intervalMinutes === intervalMinutes;
    if (same) {
      if (input.beginAt !== undefined && input.beginAt !== prior.beginAt) {
        prior.beginAt = input.beginAt;
        prior.pendingWake = true;
        prior.pendingReason = "manual";
        this.save();
      }
      if (prior.paused) { prior.paused = false; prior.lastError = null; this.save(); void this.pump(); }
      return prior;
    }
    const row: CaffyConfig = {
      sessionId: canonicalId, browserSessionId,
      publicSessionId: identity?.id ?? prior?.publicSessionId,
      conversationId: input.conversationId,
      mode: input.mode, intervalMinutes,
      startup: input.mode === "startup" ? true : input.startup ?? false, onceOnly: input.onceOnly ?? false,
      keepAwake: input.keepAwake ?? true, paused: false, createdAt: now,
      expiresAt: input.durationMinutes === undefined ? null :
        Math.max(now, input.beginAt ?? prior?.beginAt ?? now) + input.durationMinutes * 60_000,
      nextDueAt: input.mode === "periodic" ? now + intervalMinutes * 60_000 : null,
      pendingWake: prior?.conversationId === input.conversationId ? prior.pendingWake : input.mode === "idle" || input.mode === "queued",
      pendingReason: prior?.conversationId === input.conversationId ? prior.pendingReason : input.mode === "idle" || input.mode === "queued" ? "manual" : null,
      pendingMessageId: prior?.conversationId === input.conversationId ? prior.pendingMessageId : null,
      lastIdleSequence: Math.max(prior?.lastIdleSequence ?? 0, identity?.idleSequence ?? 0),
      lastWakeAt: prior?.lastWakeAt ?? null, lastError: null,
      beginAt: input.beginAt !== undefined ? input.beginAt : prior?.beginAt ?? null,
      autoRebootMinutes: ["idle", "queued"].includes(input.mode) ? prior?.autoRebootMinutes ?? null : null,
      lastActivatedAt: prior?.lastActivatedAt ?? null,
      lastRebootAt: prior?.lastRebootAt ?? null,
      rebootOperationId: prior?.rebootOperationId ?? null,
      rebootOldConversationId: prior?.rebootOldConversationId ?? null,
    };
    if (prior && prior.sessionId !== row.sessionId) this.entries.delete(prior.sessionId);
    this.entries.set(row.sessionId, row);
    this.save();
    void this.pump();
    return row;
  }

  /**
   * Lifecycle retirement is terminal. Nothing left queued for this recipient
   * may be retried or automatically remounted after close / hide / snooze.
   * The outbox keeps an audit of any attempted but uncertain sends.
   */
  retire(sessionId: string, reason: "closed" | "hidden" | "snoozed" | "missing" | "stopped") {
    const row = this.lookup(sessionId);
    const ids = row
      ? [...new Set([sessionId, row.sessionId, row.browserSessionId, row.publicSessionId]
          .filter((id): id is string => !!id))]
      : [sessionId];
    if (row) this.entries.delete(row.sessionId);
    const detail = `Recipient ${reason}; Caffy delivery retired.`;
    const cancelled = this.deliveries.retireRecipient(ids, row?.conversationId ?? null,
      detail, reason === "snoozed" || reason === "hidden" || reason === "stopped");
    if (row) this.missingSessions.delete(`${row.sessionId}:${row.conversationId}`);
    if (row) this.save();
    return { stopped: !!row, cancelled };
  }

  stop(sessionId: string) {
    const { stopped } = this.retire(sessionId, "stopped");
    return { stopped };
  }

  async beginAt(sessionId: string, conversationId: string, at: number | null) {
    if (at !== null && (!Number.isSafeInteger(at) || at <= Date.now() ||
        at > Date.now() + 90 * 24 * 60 * 60_000))
      throw new Error("Begin working must be within the next 90 days.");
    let row = this.lookup(sessionId);
    if (!row) {
      if (at === null) return { cleared: true };
      row = await this.set({ sessionId, conversationId, mode: "idle",
        onceOnly: true, keepAwake: false, beginAt: at });
      return row;
    }
    if (row.conversationId !== conversationId)
      throw new Error("Delayed start requires the same registered conversation.");
    if (row.rebootOperationId) throw new Error("A reboot is awaiting reconciliation.");
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
      this.deliveries.cancel(messageId);
    }
    if (row.expiresAt !== null) {
      const base = row.beginAt ?? row.createdAt;
      const duration = Math.max(60_000, row.expiresAt - base);
      row.expiresAt = (at ?? Date.now()) + duration;
    }
    row.beginAt = at;
    row.pendingWake = true;
    row.pendingReason = "manual";
    this.save();
    if (at === null) void this.pump();
    return row;
  }

  autoReboot(sessionId: string, minutes: number | null) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("Configure Wake on Idle before enabling auto-reboot.");
    if (row.mode !== "idle" && row.mode !== "queued")
      throw new Error("Auto-reboot only supports Wake on Idle and Wake on Idle (Queued).");
    if (minutes !== null && row.onceOnly)
      throw new Error("Auto-reboot requires continuous idle waking, not Once only.");
    if (minutes !== null && ![30, 60, 120].includes(minutes))
      throw new Error("Auto-reboot frequency must be 30, 60 or 120 minutes.");
    row.autoRebootMinutes = minutes;
    this.save();
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
    row.lastRebootAt ??= Date.now();
    row.rebootOperationId = null;
    row.rebootOldConversationId = null;
    row.pendingWake = false;
    row.pendingReason = null;
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
    if (!bound || bound.working || this.entries.get(row.sessionId) !== row ||
        (row.mode === "queued" && !(await this.hasCapacity().catch(() => false)))) return;
    const evidence = original?.ok && "data" in original && original.data &&
      typeof original.data === "object" ? original.data as {
        conversationGuardValidated?: boolean; verifiedConversationId?: string;
        session?: {messages?: Array<{role?: string; text?: string}>};
      } : null;
    const originalText = evidence?.conversationGuardValidated === true &&
      evidence.verifiedConversationId === row.conversationId
        ? evidence.session?.messages?.find(m => m.role === "user")?.text?.trim() : null;
    const prompt = "Resume your previous assignment in this same T3 browser session. " +
      "This is a continuation, not a fresh task: inspect project files and TaskBoard " +
      "progress before changing anything, and do not repeat finished work. " +
      "Continue working until genuinely finished.\n" +
      (originalText && originalText.length <= 20_000
        ? "\nOriginal user assignment (for context, not a request to redo completed steps):\n" +
          originalText : "\nReview your original assignment and project instructions.");
    const operationId = NodeCrypto.randomUUID();
    row.rebootOperationId = operationId;
    row.rebootOldConversationId = row.conversationId;
    row.pendingWake = false;
    row.pendingReason = null;
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
    this.save();
    if (!paused) { this.deliveries.resumeAllowed(); void this.pump(); }
    return row;
  }

  startup(sessionId: string, enabled: boolean) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
    if (!enabled && row.mode === "startup") return this.stop(sessionId);
    row.startup = enabled;
    this.save();
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
      (entry.conversationId === conversationId ||
        entry.bootstrapIdentity?.conversationId === conversationId)
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
    reservations: ReadonlyArray<{requestId: string; sessionId: string | null}>,
    inventoryReady = true,
  ) {
    this.taskReservations = reservations.map(row => ({
      requestId: row.requestId,
      sessionId: row.sessionId,
    }));
    this.taskBoardInventoryReady = inventoryReady;
  }

  async capacity(extraReserved = 0): Promise<{
    observedAt: string; limit: number; working: number; reserved: number;
    unknown: number; used: number; available: number;
    admissible: boolean; reason: string | null;
  }> {
    const policy = this.keepT3Busy;
    const unavailable = (reason: string) => ({
      observedAt: new Date().toISOString(), limit: this.maxWorking,
      working: 0, reserved: extraReserved + this.taskReservations.length, unknown: 1,
      used: this.maxWorking, available: 0, admissible: false, reason,
    });
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    }).catch(() => null);
    if (!reply?.ok || !("data" in reply) || !reply.data || typeof reply.data !== "object")
      return unavailable("T3 inventory unavailable");
    const data = reply.data as { sessions?: Array<WorkCapacitySessionIdentity & {
      activity?: string; status?: string; statusObservedAt?: string;
    }>; total?: number; hasMore?: boolean; incomplete?: boolean };
    if (!Array.isArray(data.sessions) || data.hasMore || data.incomplete ||
        (data.total !== undefined && data.total !== data.sessions.length)) return unavailable("T3 inventory incomplete");
    const now = Date.now();
    for (const [reporter, state] of this.workingReports)
      if (now - state.observedAt > 25_000) this.workingReports.delete(reporter);
    if (this.workingReports.size === 0)
      return unavailable("Live ChatGPT working-session count unavailable");
    const canonical = sessionWorkCapacityIdentityResolver(data.sessions);
    const workingIds = new Set(data.sessions.filter(s => {
      const observed = Date.parse(s.statusObservedAt ?? "");
      return Number.isFinite(observed) && observed <= now + 1000 && now - observed <= 15_000 &&
        (s.activity === "working" || s.status === "working");
    }).map(s => s.id).filter((id): id is string => !!id).map(canonical));
    for (const report of this.workingReports.values())
      for (const id of report.ids) workingIds.add(canonical(id));
    // A newly queued message may not yet be reflected as 'working' by T3.
    // Count it as a provisional slot, or one pump could enqueue 6+ wakes.
    const reserved = [...this.entries.values()].filter(row =>
      row.mode === "queued" &&
      ![row.sessionId, row.browserSessionId, row.publicSessionId]
        .some(id => !!id && workingIds.has(canonical(id))) &&
      (row.pendingMessageId !== null ||
        (row.lastWakeAt !== null && now - row.lastWakeAt < 120_000))).length;
    const taskReserved = this.taskReservations.filter(row =>
      !row.sessionId || !workingIds.has(canonical(row.sessionId))).length;
    const totalReserved = reserved + extraReserved + taskReserved;
    const used = workingIds.size + totalReserved;
    if (!this.taskBoardInventoryReady) {
      return {
        observedAt: new Date(now).toISOString(), limit: this.maxWorking,
        working: workingIds.size, reserved: totalReserved, unknown: 1,
        used: this.maxWorking, available: 0, admissible: false,
        reason: "TaskBoard queue reservation inventory unavailable",
      };
    }
    return {
      observedAt: new Date(now).toISOString(), limit: this.maxWorking,
      working: workingIds.size, reserved: totalReserved, unknown: 0,
      used, available: Math.max(0, this.maxWorking - used),
      admissible: policy && used < this.maxWorking,
      reason: !policy ? "Keep T3 Busy disabled" : used < this.maxWorking ? null : "At capacity",
    };
  }

  /** Do not force a shutdown on a transient zero or stale observation.
   * Error/orange/red sessions are not working. Persist OFF before /s /f /t 0.
   * No fallback to guessed zero when the live header or inventory is missing. */
  private async checkShutdown(): Promise<void> {
    if (!this.started || !this.shutdownWhenIdle || this.shutdownChecking) return;
    this.shutdownChecking = true;
    try {
      const snapshot = await this.capacity();
      if (!this.started || !this.shutdownWhenIdle) return;
      // A completed queued wake has a two-minute capacity cooldown; it is
      // *not* an active session and must not hold the PC awake indefinitely.
      // Only actual workers, active outbox attempts or pending starts matter.
      const sending = [...this.entries.values()].some(row => {
        if (row.paused || !row.pendingMessageId) return false;
        try {
          return ["queued", "sending", "uncertain"].includes(
            this.deliveries.status(row.pendingMessageId).status,
          );
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

  private async hasCapacity(): Promise<boolean> {
    return (await this.capacity()).admissible;
  }

  get policyEnabled(): boolean { return this.keepT3Busy; }

  /**
   * TaskBoard yields to waiting queued Caffy recipients, including unloaded
   * ChatGPT pages, before it can claim another automatic worker slot.
   * Invalid bindings are excluded once their reconciliation error is known.
   */
  get hasPendingQueuedWakes(): boolean {
    const now = Date.now();
    return this.keepT3Busy && [...this.entries.values()].some(row =>
      row.mode === "queued" && row.pendingWake && !row.paused &&
      !row.pendingMessageId && row.lastError === null &&
      // A queued wake intentionally delayed by the user does not reserve
      // priority/capacity until its activation deadline.
      (row.beginAt == null || row.beginAt <= now) &&
      (row.expiresAt === null || row.expiresAt > now));
  }

  private async pump() {
    if (!this.started) return;
    if (this.pumping) { this.pumpRequested = true; return; }
    this.pumping = true;
    try {
      await this.reconcileIdentityAliases().catch(() => {});
      const now = Date.now();
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
          if (row.mode === "periodic" && !row.onceOnly && !row.paused &&
              (row.lastWakeAt === null || row.lastWakeAt < row.expiresAt)) {
            // A finite periodic monitor includes its final due wake, even if
            // T3 was unavailable at the deadline. Drain it exactly once.
            row.pendingWake = true;
            row.pendingReason = "periodic";
            row.onceOnly = true;
            row.expiresAt = null;
            row.nextDueAt = null;
            this.save();
          } else {
            this.entries.delete(row.sessionId);
            this.save();
            continue;
          }
        }
        if (row.pendingMessageId) {
          try {
            this.onDelivery(this.deliveries.status(row.pendingMessageId));
          } catch {
            // Crash between persisting the ID and enqueuing it: reuse that ID.
            try {
              this.deliveries.enqueue({
                messageId: row.pendingMessageId, sessionId: row.sessionId,
                conversationId: row.conversationId, body: WAKE_TEXT,
              });
            } catch (error) { row.lastError = String(error); this.save(); }
          }
          continue;
        }
        if (row.paused) continue;
        if (row.mode === "periodic" && row.nextDueAt !== null && row.nextDueAt <= now) {
          row.nextDueAt = now + row.intervalMinutes * 60_000;
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
        if (row.mode === "queued" && !(await this.hasCapacity().catch(() => false))) continue;
        // A cold or errored session cannot pass a live guarded read until
        // it has been mounted. Enqueue from the exact registry binding so
        // the *existing* T3 delivery queue will mount/recover it. The guarded
        // send still refuses a working composer, draft or wrong conversation.
        const bound = await this.registered(row.sessionId, row.conversationId).catch(() => null);
        if (this.entries.get(row.sessionId) !== row || row.paused ||
            (row.mode === "queued" && !this.keepT3Busy)) continue;
        if (!bound) {
          const reason = "T3 cannot verify this exact session and conversation; pending wake retained.";
          if (row.lastError !== reason) { row.lastError = reason; this.save(); }
          continue;
        }
        if (bound.working) {
          if (!row.lastActivatedAt) { row.lastActivatedAt = Date.now(); this.save(); }
          continue;
        }
        const rebootAnchor = row.lastRebootAt ??
          row.lastActivatedAt ?? row.lastWakeAt ??
          (row.mode === "idle" ? row.createdAt : null);
        if ((row.mode === "idle" || row.mode === "queued") &&
            row.autoRebootMinutes && rebootAnchor !== null &&
            now - rebootAnchor >= row.autoRebootMinutes * 60_000) {
          await this.beginAutoReboot(row);
          continue;
        }
        if (row.lastError) { row.lastError = null; this.save(); }
        // Persist the exact stable message ID before enqueue; an ambiguous
        // result is reconciled by this ID rather than generating another wake.
        const messageId = NodeCrypto.randomUUID();
        row.pendingMessageId = messageId;
        row.pendingWake = false;
        row.pendingReason = null;
        this.save();
        try {
          this.deliveries.enqueue({
            messageId, sessionId: row.sessionId,
            conversationId: row.conversationId, body: WAKE_TEXT,
          });
        } catch (error) {
          // Keep the ID pinned; the journal might already contain it.
          row.lastError = String(error);
          this.save();
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
