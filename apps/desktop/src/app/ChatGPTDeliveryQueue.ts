// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Main-process filesystem/IPC boundary owns durable delivery and retry timers.
/**
 * Durable at-least-once outbox for messages typed into ChatGPT browser sessions.
 *
 * ChatGPT is an unreliable receiver: a send can land without T3 being able to
 * prove it. Duplicates are acceptable, getting stuck is not. So:
 *   - Every message carries a `[T3-MSG:<id>]` marker. Each attempt is a plain
 *     `send`; the renderer first looks for the marker and reports
 *     `user_turn_observed` instead of sending again when it is already visible.
 *   - Not observed after a send: retry with backoff (1, 2, 4, then every 5 min).
 *   - Refused before submission (draft, busy, unmounted): retry soon, nothing sent.
 *   - Every message reaches a terminal state: delivered, cancelled, or
 *     `needs_attention` (gave up GIVE_UP_MS after becoming its lane's head;
 *     the user is notified).
 * Lanes: one in-flight message per conversation, FIFO within a lane, lanes
 * independent. Because the head always terminates, a lane can never stall.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";

/**
 * queued: waiting for its first send (or for the recipient to mount).
 * sending: a send round trip is running.
 * uncertain: sent at least once but not yet observed; checked and resent automatically.
 * delivered: marked user turn observed.
 * needs_attention: gave up after GIVE_UP_MS (terminal; user was notified).
 * cancelled: retired by the caller or recipient lifecycle (terminal).
 */
export type DeliveryState =
  | "queued"
  | "sending"
  | "uncertain"
  | "delivered"
  | "needs_attention"
  | "cancelled";
export interface DeliveryRecord {
  messageId: string;
  sessionId: string;
  conversationId: string;
  body: string;
  /** Trusted main-process Caffy wake, independent of user-written body text. */
  caffyWake?: boolean;
  status: DeliveryState;
  /** Delivery passes that reached the renderer (sends and refusals). */
  attempts: number;
  /** Sends that may have reached ChatGPT; drives the resend backoff. */
  duplicateResends?: number;
  /** When the last possibly-submitted send began. */
  lastSubmissionAt?: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  /** Renderer confirmed this exact marker exists in a verified user turn. */
  observedDeliveryId?: string;
  /** Recipient guest is unloaded; a mount report (or the periodic retry) resumes it. */
  awaitingGuest?: boolean;
}

type BrowserRequest = Extract<DesktopAppActivationRequest, { type: "chatgpt.sessions" }>;
type Sender = (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
type PublicRecord = Omit<DeliveryRecord, "body">;
const MARKER = (messageId: string) => `[T3-MSG:${messageId}]`;
const CAFFY_WAKE_BODY = "Continue working on your current assignment. If everything is genuinely finished, stop Caffy for this session using the caffy tool (action=stop, sessionId=your T3_ID).";
const isCaffyRecord = (record: DeliveryRecord) => record.caffyWake === true || record.body === CAFFY_WAKE_BODY;
const PREFLIGHT_RETRY_MS = 15_000;
const UNMOUNTED_RETRY_MS = 60_000;
const MAX_RESEND_DELAY_MS = 5 * 60_000;
/** Resend delay after the n-th unobserved send: 1, 2, 4, then 5 minutes. */
const resendDelay = (sends: number) => Math.min(MAX_RESEND_DELAY_MS, 60_000 * 2 ** Math.max(0, sends - 1));
/** Every lane head terminates: give up (and notify) this long after it became head. */
const GIVE_UP_MS = 60 * 60_000;
const MAX_ACTIVE_CONVERSATIONS = 4;
const isUuid = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
const terminal = (status: DeliveryState) =>
  status === "delivered" || status === "cancelled" || status === "needs_attention";

/** Renderer refusals that happen before anything is submitted. Misclassifying
 * either way is harmless now: it only changes how soon the next attempt runs. */
function refusedBeforeSubmission(response: DesktopAppActivationResponse) {
  return (
    !response.ok &&
    !/UNKNOWN|indeterminate|may (?:already )?have occurred/i.test(response.message) &&
    /no message sent|no click issued|refusing (?:send|to overwrite)|not (?:yet )?mounted|not attached|not confirmed idle|Cannot send while session is|User-focused composer|aborting|hibernated|session is missing/i.test(
      response.message,
    )
  );
}

const unmounted = (detail: string) =>
  /not (?:yet )?mounted|not attached|hibernated|session is missing|unavailable before/i.test(detail);

/** Accepted means persisted, never that a model read the message. */
export class ChatGPTDeliveryQueue {
  private readonly file: string;
  private readonly eventFile: string;
  private readonly send: Sender;
  private readonly records = new Map<string, DeliveryRecord>();
  private readonly transitionListeners = new Set<(record: PublicRecord) => void>();
  private dispatchAllowed: (record: { messageId: string; sessionId: string }) => boolean = () => true;
  private dispatchAdmission: (record: { messageId: string; sessionId: string }) => Promise<boolean> = async () => true;
  private selectionGate: Promise<void> = Promise.resolve();
  private readonly activeConversations = new Set<string>();
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private nextTry = new Map<string, number>();
  /** When each message became its lane's head (in memory; a restart grants a fresh hour). */
  private headSince = new Map<string, number>();
  private lastScheduledConversation: string | undefined;
  private readonly notifyExhausted: (record: PublicRecord) => void;

  /** `notifyExhausted` fires once when a message gives up (desktop notification). */
  constructor(directory: string, send: Sender, notifyExhausted: (record: PublicRecord) => void = () => {}) {
    this.notifyExhausted = notifyExhausted;
    this.send = send;
    NodeFS.mkdirSync(directory, { recursive: true });
    this.file = NodePath.join(directory, "chatgpt-deliveries-v1.json");
    this.eventFile = NodePath.join(directory, "chatgpt-delivery-events.ndjson");
    if (NodeFS.existsSync(this.file)) {
      const loaded: unknown = JSON.parse(NodeFS.readFileSync(this.file, "utf8"));
      if (!Array.isArray(loaded)) throw new Error("ChatGPT delivery journal is not an array.");
      for (const value of loaded) {
        const r = value as DeliveryRecord;
        if (
          !r ||
          !isUuid(r.messageId) ||
          !isUuid(r.conversationId) ||
          typeof r.sessionId !== "string" ||
          typeof r.body !== "string" ||
          typeof r.createdAt !== "number" ||
          !r.status
        )
          throw new Error("ChatGPT delivery journal contains an invalid record.");
        // A crash mid-send leaves "sending": it may have landed, check and resend.
        this.records.set(r.messageId, { ...r, status: r.status === "sending" ? "uncertain" : r.status });
      }
    }
    this.save();
  }

  /** Atomic replacement: never report accepted until the message survives a crash. */
  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      NodeFS.writeFileSync(tmp, JSON.stringify([...this.records.values()]), {
        encoding: "utf8",
        flag: "w",
        flush: true,
      });
      NodeFS.renameSync(tmp, this.file);
    } finally {
      if (NodeFS.existsSync(tmp)) NodeFS.unlinkSync(tmp);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    // The first drain recovers persisted messages missed during a crash.
    void this.pulse().catch(() => {});
  }

  /** Caffy uses these to pause its own wakes; ordinary traffic is unaffected. */
  setDispatchPermission(check: (record: { messageId: string; sessionId: string }) => boolean) {
    this.dispatchAllowed = check;
  }
  setDispatchAdmission(check: (record: { messageId: string; sessionId: string }) => Promise<boolean>) {
    this.dispatchAdmission = check;
  }
  resumeAllowed() {
    void this.pulse().catch(() => {});
  }

  /** One-shot timer to the earliest lane head that is due. */
  private scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.closed || this.activeConversations.size >= MAX_ACTIVE_CONVERSATIONS)
      return;
    const seen = new Set<string>();
    let next = Number.POSITIVE_INFINITY;
    for (const record of this.records.values()) {
      if (terminal(record.status) || seen.has(record.conversationId)) continue;
      seen.add(record.conversationId);
      if (this.activeConversations.has(record.conversationId)) continue;
      // Paused Caffy wakes still need a timer so they can give up eventually.
      const due = this.dispatchAllowed(record)
        ? (this.nextTry.get(record.messageId) ?? 0)
        : (this.headSince.get(record.messageId) ?? Date.now()) + GIVE_UP_MS;
      next = Math.min(next, due);
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.pulse().catch(() => {});
      },
      Math.max(0, Math.min(2_147_483_647, next - Date.now())),
    );
    this.timer.unref?.();
  }

  /** A verified idle edge is a good moment to retry this recipient right away. */
  onIdleTransition(event: { sessionId: string; conversationId: string }) {
    if (!this.started || this.closed || !isUuid(event.conversationId)) return;
    let ready = false;
    for (const record of this.records.values()) {
      if (
        record.sessionId !== event.sessionId ||
        record.conversationId !== event.conversationId ||
        terminal(record.status) ||
        record.awaitingGuest
      )
        continue;
      this.nextTry.delete(record.messageId);
      ready = true;
    }
    if (ready) void this.pulse().catch(() => {});
  }

  /** The renderer saw this exact conversation mounted: resume its lane now. */
  onRecipientMounted(event: { sessionId: string; conversationId: string }) {
    if (this.closed || !isUuid(event.conversationId)) return false;
    let ready = false;
    for (const record of this.records.values()) {
      if (record.sessionId !== event.sessionId || record.conversationId !== event.conversationId ||
          terminal(record.status) || !record.awaitingGuest) continue;
      record.awaitingGuest = false;
      this.nextTry.delete(record.messageId);
      this.update(record, record.status);
      ready = true;
    }
    if (ready && this.started) void this.pulse().catch(() => {});
    return ready;
  }

  /** Called only after the queue has persisted a transition; no composer access. */
  subscribeTransitions(listener: (record: PublicRecord) => void) {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  private notifyTransition(record: DeliveryRecord) {
    const safe = this.publicRecord(record);
    for (const listener of this.transitionListeners) {
      try {
        listener(safe);
      } catch {
        /* Receipt telemetry may not disrupt delivery. */
      }
    }
  }

  close() {
    this.closed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
  }

  enqueue(input: { messageId: string; sessionId: string; conversationId: string; body: string; caffyWake?: boolean }) {
    if (
      !isUuid(input.messageId) ||
      !isUuid(input.conversationId) ||
      !input.sessionId.trim() ||
      !input.body.trim() ||
      input.body.length > 29_800
    )
      throw new Error(
        "Valid UUID messageId, conversationId, sessionId, and 1-29800 character body required.",
      );
    const existing = this.records.get(input.messageId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.conversationId !== input.conversationId ||
        existing.body !== input.body ||
        (existing.caffyWake === true) !== (input.caffyWake === true)
      )
        throw new Error("Message ID already belongs to a different payload or recipient.");
      return this.publicRecord(existing);
    }
    const now = Date.now();
    const record: DeliveryRecord = {
      ...input,
      status: "queued",
      // Wait for the renderer to report the recipient mounted; the periodic
      // retry also tries on its own in case that report never comes.
      awaitingGuest: true,
      attempts: 0,
      duplicateResends: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(input.messageId, record);
    try {
      this.save();
    } catch (error) {
      this.records.delete(input.messageId);
      throw error;
    }
    this.notifyTransition(record);
    if (this.started) void this.pulse().catch(() => {});
    return this.publicRecord(record);
  }

  status(messageId: string) {
    const record = this.records.get(messageId);
    if (!record) throw new Error("Unknown delivery messageId.");
    return this.publicRecord(record);
  }

  list() {
    return [...this.records.values()].map((row) => this.publicRecord(row));
  }

  /** Read-only, privacy-safe diagnostics of the actual persisted delivery journal. */
  diagnostics() {
    const all = this.list();
    const counts: Record<DeliveryState, number> = {
      queued: 0,
      sending: 0,
      uncertain: 0,
      delivered: 0,
      needs_attention: 0,
      cancelled: 0,
    };
    for (const row of all) counts[row.status]++;
    const active = all.filter((row) => !terminal(row.status));
    const recent = all
      .filter((row) => terminal(row.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
    const diagnoses = new Map<string, ReturnType<ChatGPTDeliveryQueue["diagnose"]>>();
    for (const row of active) {
      if (!diagnoses.has(row.conversationId)) {
        diagnoses.set(row.conversationId, this.diagnose(row.conversationId));
      }
    }
    return {
      sampledAt: Date.now(),
      total: all.length,
      counts,
      newCount: all.filter((row) => row.status === "queued" && row.attempts === 0).length,
      messages: [...active, ...recent].slice(0, 250).map((row) => {
        const head = diagnoses.get(row.conversationId);
        return {
          messageId: row.messageId,
          sessionId: row.sessionId,
          conversationId: row.conversationId,
          status: row.status,
          attempts: row.attempts,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          reason: head?.oldestMessageId === row.messageId ? (head.reason ?? null) : null,
          queuedBehind: head?.oldestMessageId === row.messageId ? head.queuedBehind : 0,
        };
      }),
    };
  }

  /** Privacy-safe, read-only conversation liveness. No guest access or journal mutation. */
  diagnose(conversationId: string, now = Date.now()) {
    const unresolved = [...this.records.values()].filter(
      (r) => r.conversationId === conversationId && !terminal(r.status),
    );
    const head = unresolved[0];
    if (!head)
      return { conversationId, blocked: false as const, queuedBehind: 0, pending: 0, needsAttention: 0 };
    // Never expose body, renderer stack/error detail, or any composer content.
    const error = head.lastError ?? "";
    const reason = head.awaitingGuest || unmounted(error)
      ? "guest_unmounted"
      : /existing draft/i.test(error)
        ? "recipient_draft_present"
        : /not confirmed idle|Cannot send while/i.test(error)
          ? "recipient_not_confirmed_idle"
          : /User-focused composer/i.test(error)
            ? "composer_user_focused"
            : head.status === "uncertain"
              ? "sent_not_yet_observed"
              : "awaiting_dispatch";
    return {
      conversationId,
      blocked: true as const,
      oldestMessageId: head.messageId,
      oldestStatus: head.status,
      oldestAgeMs: Math.max(0, now - head.createdAt),
      oldestAttempts: head.attempts,
      queuedBehind: unresolved.length - 1,
      pending: unresolved.length,
      needsAttention: 0,
      reason,
      nextStep: reason === "sent_not_yet_observed" ? "check_then_resend" : "retry_automatically",
    };
  }

  /** Stop delivering one message, whatever its state. */
  cancel(messageId: string) {
    const record = this.records.get(messageId);
    if (!record) throw new Error("Unknown delivery messageId.");
    this.retireRecipient([record.sessionId], record.conversationId,
      "Delivery cancelled.", false, record.messageId);
    return this.publicRecord(record);
  }

  /** A closed, hidden, snoozed or removed recipient gets no further delivery. */
  retireRecipient(
    sessionIds: readonly string[],
    conversationId: string | null,
    reason: string,
    caffyOnly = false,
    messageId?: string,
  ): number {
    const ids = new Set(sessionIds);
    const retired: DeliveryRecord[] = [];
    for (const row of this.records.values()) {
      if (messageId && row.messageId !== messageId) continue;
      if (!ids.has(row.sessionId) ||
          (conversationId && row.conversationId !== conversationId) ||
          (caffyOnly && !isCaffyRecord(row)) ||
          terminal(row.status)) continue;
      row.status = "cancelled";
      row.updatedAt = Date.now();
      row.lastError = reason;
      this.nextTry.delete(row.messageId);
      retired.push(row);
    }
    if (retired.length) {
      this.save();
      for (const row of retired) this.notifyTransition(row);
      this.scheduleNext();
    }
    return retired.length;
  }

  private publicRecord(record: DeliveryRecord): PublicRecord {
    // Never expose full prompt contents through delivery status/logging.
    const { body: _body, ...result } = record;
    return result;
  }

  private update(record: DeliveryRecord, status: DeliveryState, error?: string) {
    // Retirement wins even if an earlier send returns after the recipient closed.
    if (record.status === "cancelled" && status !== "cancelled") return;
    const previousStatus = record.status;
    const previousError = record.lastError;
    record.status = status;
    record.updatedAt = Date.now();
    if (error === undefined) delete record.lastError;
    else record.lastError = error;
    this.save();
    if (previousStatus !== status || previousError !== record.lastError) {
      try {
        NodeFS.appendFileSync(this.eventFile, JSON.stringify({ at: record.updatedAt, messageId: record.messageId, sessionId: record.sessionId, from: previousStatus, to: status, attempts: record.attempts, reason: record.lastError ?? null }) + "\n");
      } catch { /* diagnostics must not prevent delivery */ }
    }
    this.notifyTransition(record);
  }

  /** Terminal give-up: notify once and free the lane. */
  private giveUp(record: DeliveryRecord) {
    const sends = record.duplicateResends ?? 0;
    this.update(record, "needs_attention", sends > 0
      ? `Gave up after ${Math.round(GIVE_UP_MS / 60_000)} minutes; sent ${sends} time(s) but never observed. ${record.lastError ?? ""}`.trim()
      : `Gave up after ${Math.round(GIVE_UP_MS / 60_000)} minutes without being able to send. ${record.lastError ?? ""}`.trim());
    this.nextTry.delete(record.messageId);
    this.headSince.delete(record.messageId);
    try { this.notifyExhausted(this.publicRecord(record)); } catch { /* notification is best effort */ }
  }

  /** Only an exact-conversation, actually-observed user turn counts as delivered. */
  private confirmed(record: DeliveryRecord, response: DesktopAppActivationResponse): boolean {
    const data = response.ok && "data" in response ? response.data : null;
    return (
      !!data &&
      typeof data === "object" &&
      "delivery" in data &&
      data.delivery === "user_turn_observed" &&
      "conversationGuardValidated" in data &&
      data.conversationGuardValidated === true &&
      "verifiedConversationId" in data &&
      data.verifiedConversationId === record.conversationId
    );
  }

  /** The renderer proved nothing was submitted (callback never ran). */
  private notSubmitted(response: DesktopAppActivationResponse): boolean {
    const data = response.ok && "data" in response ? response.data : null;
    return !!data && typeof data === "object" && "delivery" in data &&
      data.delivery === "pre_submit_aborted";
  }

  /** One delivery pass: send (the renderer skips the send if the marker is
   * already visible) and schedule the next pass from the outcome. */
  private async process(record: DeliveryRecord) {
    if (terminal(record.status)) return;
    record.attempts++;
    const wasSentBefore = (record.duplicateResends ?? 0) > 0;
    const startedAt = Date.now();
    this.update(record, "sending", record.lastError);
    let response: DesktopAppActivationResponse;
    try {
      response = await this.send({
        version: 1,
        requestId: NodeCrypto.randomUUID(),
        type: "chatgpt.sessions",
        action: "send",
        sessionId: record.sessionId,
        expectedConversationId: record.conversationId,
        message: `${MARKER(record.messageId)}\n${record.body}`,
        // The renderer refuses to submit a request that arrives this late.
        sendExpiresAt: startedAt + 70_000,
      } satisfies BrowserRequest);
    } catch (error) {
      response = { ok: false, message: String(error) } as DesktopAppActivationResponse;
    }
    // The recipient may have been retired while the send was running.
    if ((record.status as DeliveryState) === "cancelled") return;
    if (this.confirmed(record, response)) {
      record.observedDeliveryId = `${MARKER(record.messageId)}:user_turn_observed`;
      this.update(record, "delivered");
      return;
    }
    const detail = response.ok
      ? ("data" in response && response.data && typeof response.data === "object" &&
          "reason" in response.data && typeof response.data.reason === "string"
          ? response.data.reason : "Send not observed yet.")
      : response.message;
    const settled: DeliveryState = wasSentBefore ? "uncertain" : "queued";
    if (this.notSubmitted(response) || refusedBeforeSubmission(response)) {
      // Nothing was submitted this pass. Unmounted guests wait for a mount report.
      if (unmounted(detail)) {
        record.awaitingGuest = true;
        this.nextTry.set(record.messageId, Date.now() + UNMOUNTED_RETRY_MS);
      } else {
        this.nextTry.set(record.messageId, Date.now() + PREFLIGHT_RETRY_MS);
      }
      this.update(record, settled, detail);
      return;
    }
    // The send may have landed. Check (and resend if absent) after a backoff.
    record.lastSubmissionAt = startedAt;
    record.duplicateResends = (record.duplicateResends ?? 0) + 1;
    this.nextTry.set(record.messageId, Date.now() + resendDelay(record.duplicateResends));
    this.update(record, "uncertain", detail);
  }

  /** Independent conversations progress concurrently; FIFO within each lane. */
  async pulse() {
    if (this.closed) return;
    // Serialize lane selection only, not the browser round trip.
    const previousSelection = this.selectionGate;
    let releaseSelection!: () => void;
    this.selectionGate = new Promise<void>(resolve => { releaseSelection = resolve; });
    await previousSelection;
    const work: Promise<void>[] = [];
    try {
      if (this.closed) return;
      const now = Date.now();
      const conversations = new Map<string, DeliveryRecord[]>();
      for (const record of this.records.values()) {
        if (terminal(record.status)) continue;
        const group = conversations.get(record.conversationId) ?? [];
        // Lane head: start its give-up clock, and give up once it runs out.
        if (!group.length && !this.activeConversations.has(record.conversationId)) {
          const since = this.headSince.get(record.messageId) ?? now;
          this.headSince.set(record.messageId, since);
          if (now - since >= GIVE_UP_MS) {
            this.giveUp(record);
            continue;
          }
        }
        group.push(record);
        conversations.set(record.conversationId, group);
      }
      const due = (record: DeliveryRecord) => (this.nextTry.get(record.messageId) ?? 0) <= Date.now();
      const lanes = [...conversations];
      const lastIndex = lanes.findIndex(([id]) => id === this.lastScheduledConversation);
      const ordered =
        lastIndex < 0 ? lanes : [...lanes.slice(lastIndex + 1), ...lanes.slice(0, lastIndex + 1)];
      for (const [conversationId, records] of ordered) {
        if (this.activeConversations.size >= MAX_ACTIVE_CONVERSATIONS) break;
        if (this.activeConversations.has(conversationId)) continue;
        const head = records[0];
        if (!head || !this.dispatchAllowed(head) || !due(head)) continue;
        // Capacity is rechecked right before sending (manual sessions may have started).
        let admitted = false;
        try { admitted = await this.dispatchAdmission(head); } catch { admitted = false; }
        if (!admitted || terminal(head.status) || !this.dispatchAllowed(head)) {
          this.nextTry.set(head.messageId, Date.now() + 10_000);
          continue;
        }
        this.activeConversations.add(conversationId);
        this.lastScheduledConversation = conversationId;
        work.push(
          (async () => {
            try {
              if (!this.closed) await this.process(head);
            } finally {
              this.activeConversations.delete(conversationId);
            }
          })(),
        );
      }
    } finally {
      releaseSelection();
    }
    await Promise.allSettled(work);
    this.scheduleNext();
  }
}
