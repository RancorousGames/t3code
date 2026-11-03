// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- T3 owns local durable timers and power requests.
// T3-owned Caffy. No OpenRig or OmniHub scheduler dependency.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";
import type { ChatGPTDeliveryQueue, DeliveryRecord } from "./ChatGPTDeliveryQueue.ts";
import type { VerifiedChatGPTIdleTransition } from "./ChatGPTIdleTransitionJournal.ts";

type Mode = "idle" | "periodic" | "queued";
type Trigger = "idle" | "periodic" | "queued" | "startup" | "manual";
type Request = (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
export interface CaffyConfig {
  sessionId: string;
  browserSessionId?: string | undefined;
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
}
interface CaffyStore { version: 2; entries: CaffyConfig[]; keepT3Busy: boolean; maxWorking: number }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const WAKE_TEXT = "Continue working on your current assignment. If everything is genuinely finished, stop Caffy for this session using the caffy tool (action=stop, sessionId=your T3_ID).";
const CLOCK = 10_000;
const valid = (row: CaffyConfig): boolean =>
  !!row && UUID.test(row.sessionId) && UUID.test(row.conversationId) &&
  ["idle", "periodic", "queued"].includes(row.mode) &&
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
  private taskReservations = 0;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private blockerId: number | null = null;
  private readonly deliveries: ChatGPTDeliveryQueue;
  private readonly request: Request;
  private readonly power: { start: () => number; stop: (id: number) => void };

  constructor(
    stateDir: string,
    deliveries: ChatGPTDeliveryQueue,
    request: Request,
    power: { start: () => number; stop: (id: number) => void },
  ) {
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
        if (Number.isInteger(saved.maxWorking) && saved.maxWorking >= 1 && saved.maxWorking <= 100)
          this.maxWorking = saved.maxWorking;
      }
    } catch { /* Corrupt/missing local state is not evidence for a wake. */ }
    this.deliveries.subscribeTransitions(record => this.onDelivery(record));
  }

  private save() {
    const tmp = this.file + "." + process.pid + ".tmp";
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify({
        version: 2, entries: [...this.entries.values()],
        keepT3Busy: this.keepT3Busy, maxWorking: this.maxWorking,
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
    this.timer = setInterval(() => { void this.pump(); }, CLOCK);
    this.timer.unref?.();
    void this.pump();
  }

  close() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.blockerId !== null) {
      try { this.power.stop(this.blockerId); } finally { this.blockerId = null; }
    }
  }

  private lookup(sessionId: string): CaffyConfig | undefined {
    return this.entries.get(sessionId) ??
      [...this.entries.values()].find(row => row.browserSessionId === sessionId);
  }

  status(sessionId?: string) {
    if (sessionId) return this.lookup(sessionId) ?? null;
    return {
      entries: [...this.entries.values()],
      keepT3Busy: this.keepT3Busy,
      maxWorking: this.maxWorking,
    };
  }

  policy(input: { keepT3Busy?: boolean | undefined; maxWorking?: number | undefined }) {
    if (input.keepT3Busy !== undefined) this.keepT3Busy = input.keepT3Busy;
    if (input.maxWorking !== undefined) {
      if (!Number.isInteger(input.maxWorking) || input.maxWorking < 1 || input.maxWorking > 100)
        throw new Error("maxWorking must be 1..100.");
      this.maxWorking = input.maxWorking;
    }
    this.save();
    void this.pump();
    return { keepT3Busy: this.keepT3Busy, maxWorking: this.maxWorking };
  }

  async set(input: {
    sessionId: string; conversationId: string; mode: Mode;
    durationMinutes?: number | undefined; onceOnly?: boolean | undefined; startup?: boolean | undefined;
    intervalMinutes?: number | undefined; keepAwake?: boolean | undefined;
  }) {
    if (!UUID.test(input.sessionId) || !UUID.test(input.conversationId))
      throw new Error("Exact sessionId and conversationId UUIDs required.");
    if (!["idle", "periodic", "queued"].includes(input.mode))
      throw new Error("Caffy mode must be idle, periodic or queued.");
    if (input.durationMinutes !== undefined &&
        (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 10_080))
      throw new Error("Duration must be 1..10080 minutes or omitted for infinite.");
    if (input.mode === "queued" && input.durationMinutes !== undefined)
      throw new Error("Queued idle waking is infinite; omit duration.");
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
    const canonicalId = identity?.id ?? input.sessionId;
    const browserSessionId = identity?.browserSessionId ?? input.sessionId;
    if ([...this.entries.values()].some(row => row.conversationId === input.conversationId &&
        row.sessionId !== canonicalId && row.browserSessionId !== input.sessionId))
      throw new Error("Another T3 Caffy monitor already owns this ChatGPT conversation.");
    if (this.legacyConflict(canonicalId, input.conversationId) ||
        this.legacyConflict(input.sessionId, input.conversationId))
      throw new Error("Legacy OmniHub Caffy monitor still owns this session; cancel it before scheduling T3 Caffy.");
    const now = Date.now();
    const prior = this.lookup(input.sessionId);
    if (prior?.pendingMessageId && prior.conversationId !== input.conversationId)
      throw new Error("Existing wake delivery needs reconciliation before changing conversations.");
    const same = !!prior && prior.conversationId === input.conversationId &&
      prior.mode === input.mode && prior.expiresAt ===
        (input.durationMinutes === undefined ? null : prior.createdAt + input.durationMinutes * 60_000) &&
      prior.onceOnly === (input.onceOnly ?? false) &&
      prior.startup === (input.startup ?? false) &&
      prior.keepAwake === (input.keepAwake ?? true) &&
      prior.intervalMinutes === intervalMinutes;
    if (same) {
      if (prior.paused) { prior.paused = false; prior.lastError = null; this.save(); void this.pump(); }
      return prior;
    }
    const row: CaffyConfig = {
      sessionId: canonicalId, browserSessionId, conversationId: input.conversationId,
      mode: input.mode, intervalMinutes,
      startup: input.startup ?? false, onceOnly: input.onceOnly ?? false,
      keepAwake: input.keepAwake ?? true, paused: false, createdAt: now,
      expiresAt: input.durationMinutes === undefined ? null : now + input.durationMinutes * 60_000,
      nextDueAt: input.mode === "periodic" ? now + intervalMinutes * 60_000 : null,
      pendingWake: prior?.conversationId === input.conversationId ? prior.pendingWake : input.mode !== "periodic",
      pendingReason: prior?.conversationId === input.conversationId ? prior.pendingReason : input.mode !== "periodic" ? "manual" : null,
      pendingMessageId: prior?.conversationId === input.conversationId ? prior.pendingMessageId : null,
      lastIdleSequence: 0,
      lastWakeAt: prior?.lastWakeAt ?? null, lastError: null,
    };
    this.entries.set(row.sessionId, row);
    this.save();
    return row;
  }

  stop(sessionId: string) {
    const row = this.lookup(sessionId);
    if (!row) return { stopped: false };
    this.entries.delete(row.sessionId);
    // A submitted or uncertain delivery may already have reached the recipient.
    // Do not cancel it blindly or silently create another.
    if (row.pendingMessageId) {
      try { this.deliveries.cancel(row.pendingMessageId); } catch { /* preserve in-flight evidence */ }
    }
    this.save();
    return { stopped: true };
  }

  pause(sessionId: string, paused: boolean) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
    if (!paused && this.legacyConflict(row.sessionId, row.conversationId))
      throw new Error("Legacy OmniHub monitor still owns this session; cancel it before resuming T3 Caffy.");
    row.paused = paused;
    this.save();
    if (!paused) void this.pump();
    return row;
  }

  startup(sessionId: string, enabled: boolean) {
    const row = this.lookup(sessionId);
    if (!row) throw new Error("No Caffy monitor for this session.");
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
    const row = this.lookup(event.sessionId);
    if (!row || row.paused || row.conversationId !== event.conversationId ||
        event.sequence <= row.lastIdleSequence) return;
    row.lastIdleSequence = event.sequence;
    if (row.mode !== "periodic" && !row.pendingMessageId) {
      row.pendingWake = true;
      row.pendingReason = "idle";
    }
    this.save();
    void this.pump();
  }

  private onDelivery(record: Omit<DeliveryRecord, "body">) {
    const row = this.entries.get(record.sessionId);
    if (!row || row.pendingMessageId !== record.messageId) return;
    if (record.status === "delivered") {
      row.pendingMessageId = null;
      row.lastWakeAt = Date.now();
      row.lastError = null;
      if (row.onceOnly) { this.entries.delete(row.sessionId); }
    } else if (record.status === "needs_attention" || record.status === "cancelled") {
      row.lastError = record.lastError ?? record.status;
      row.paused = true; // no unbounded speculative new message
    }
    this.save();
  }

  private async registered(sessionId: string, conversationId: string): Promise<{ id: string; browserSessionId: string; working: boolean } | null> {
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
      closedAt?: unknown;
    }> }).sessions;
    if (!Array.isArray(entries)) return null;
    const matches = entries.filter(entry => entry.id === sessionId ||
      entry.browserSessionId === sessionId || entry.publicSessionId === sessionId ||
      entry.bootstrapIdentity?.publicId === sessionId);
    const entry = matches.length === 1 ? matches[0] : null;
    return entry?.id && entry.closedAt == null &&
      (entry.conversationId === conversationId ||
        entry.bootstrapIdentity?.conversationId === conversationId)
      ? {
          id: entry.bootstrapIdentity?.publicId ?? entry.id, browserSessionId: entry.browserSessionId ?? entry.id,
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

  setTaskReservations(count: number) {
    this.taskReservations = Math.max(0, Math.floor(count));
  }

  async capacity(extraReserved = 0): Promise<{
    observedAt: string; limit: number; working: number; reserved: number;
    unknown: number; used: number; available: number;
    admissible: boolean; reason: string | null;
  }> {
    const policy = this.keepT3Busy;
    const unavailable = (reason: string) => ({
      observedAt: new Date().toISOString(), limit: this.maxWorking,
      working: 0, reserved: extraReserved + this.taskReservations, unknown: 1,
      used: this.maxWorking, available: 0, admissible: false, reason,
    });
    const reply = await this.request({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    });
    if (!reply.ok || !("data" in reply) || !reply.data || typeof reply.data !== "object") return unavailable("T3 inventory unavailable");
    const data = reply.data as { sessions?: Array<{
      id?: string; activity?: string; status?: string; statusObservedAt?: string;
    }>; total?: number; hasMore?: boolean; incomplete?: boolean };
    if (!Array.isArray(data.sessions) || data.hasMore || data.incomplete ||
        (data.total !== undefined && data.total !== data.sessions.length)) return unavailable("T3 inventory incomplete");
    const now = Date.now();
    const workingIds = new Set(data.sessions.filter(s => {
      const observed = Date.parse(s.statusObservedAt ?? "");
      return Number.isFinite(observed) && observed <= now + 1000 && now - observed <= 15_000 &&
        (s.activity === "working" || s.status === "working");
    }).map(s => s.id).filter((id): id is string => !!id));
    // A newly queued message may not yet be reflected as 'working' by T3.
    // Count it as a provisional slot, or one pump could enqueue 6+ wakes.
    const reserved = [...this.entries.values()].filter(row =>
      row.mode === "queued" &&
      !workingIds.has(row.sessionId) && !workingIds.has(row.browserSessionId ?? row.sessionId) &&
      (row.pendingMessageId !== null ||
        (row.lastWakeAt !== null && now - row.lastWakeAt < 120_000))).length;
    const totalReserved = reserved + extraReserved + this.taskReservations;
    const used = workingIds.size + totalReserved;
    return {
      observedAt: new Date(now).toISOString(), limit: this.maxWorking,
      working: workingIds.size, reserved: totalReserved, unknown: 0,
      used, available: Math.max(0, this.maxWorking - used),
      admissible: policy && used < this.maxWorking,
      reason: !policy ? "Keep T3 Busy disabled" : used < this.maxWorking ? null : "At capacity",
    };
  }

  private async hasCapacity(): Promise<boolean> {
    return (await this.capacity()).admissible;
  }

  get policyEnabled(): boolean { return this.keepT3Busy; }

  private async pump() {
    if (!this.started || this.pumping) return;
    this.pumping = true;
    try {
      const now = Date.now();
      for (const row of [...this.entries.values()]) {
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
        if (bound.working) continue;
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
    }
  }
}
