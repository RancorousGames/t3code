// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Main-process filesystem/IPC boundary owns durable delivery and retry timers.
// Durable browser-message outbox. The desktop main process owns retries, not React
// components or application callers. One in-flight message per conversation.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";

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
  status: DeliveryState;
  attempts: number;
  /** Number of duplicate-risk submissions, persisted across desktop restarts. */
  duplicateResends?: number;
  /** Repeated preflight refusals because a composer has an existing draft. */
  draftRefusals?: number;
  /** When the last attempted submission began, including an ambiguous one. */
  lastSubmissionAt?: number;
  /** Start of the unresolved delivery, so retries keep their schedule after restart. */
  uncertainSince?: number;
  /** Renderer refuses a late first submission after this time; required for safe pre-submit recovery. */
  sendExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  /** Renderer confirmed this exact marker exists in a verified user turn. */
  observedDeliveryId?: string;
  /** Suspended while guest is unloaded; only an observed mount can resume it. */
  awaitingGuest?: boolean;
}

type BrowserRequest = Extract<DesktopAppActivationRequest, { type: "chatgpt.sessions" }>;
type Sender = (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
const MARKER = (messageId: string) => `[T3-MSG:${messageId}]`;
// Keep wake notices free of T3-MSG prefixes; the outbox still owns their IDs.
const isWakeBody = (body: string) =>
  /^WAKE - Elapsed: (?:\d+h)?\d+m \| This: \d{2}:\d{2}\n {7}Next: (?:\d{2}:\d{2}|—) \| Final: \d{2}:\d{2}\nTo stop wakes, call keep_awake\.complete\([a-f0-9]{12}\)$/.test(
    body,
  ) ||
  /^\[WAKE [1-9]\d*\] - To stop wakes, call keep_awake\.complete\([a-f0-9]{12}\)\. Total time elapsed: (?:\d+h)?\d+m$/.test(
    body,
  );
const isCaffyWakeBody = (body: string) => body.startsWith("Continue working on your current assignment. If everything is genuinely finished, stop Caffy");
const deliveryText = (record: DeliveryRecord) =>
  isWakeBody(record.body) ? record.body : `${MARKER(record.messageId)}\n${record.body}`;
// Existing marked messages use bounded retry; wake messages remain reconciliation-only.
const DUPLICATE_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];
const LONG_RETRY_MS = 15 * 60_000;
const RECONCILE_RETRY_MS = 60_000;
const PREFLIGHT_RETRY_MS = 15_000;
const MAX_ACTIVE_CONVERSATIONS = 4;
const MAX_DELIVERY_ATTEMPTS = 100;
const isUuid = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);

// These failures happen before the renderer touches the composer. Keep this
// legacy-text adapter here; arbitrary IPC errors can still follow a real send.
function refusedBeforeSubmission(response: DesktopAppActivationResponse) {
  return (
    !response.ok &&
    !/Outcome UNKNOWN|outcome indeterminate|may already have occurred/i.test(response.message) &&
    /User-focused composer before typing; no message sent|Automated composer ownership still active before typing; no message sent|Composer contains an existing draft; refusing to overwrite it|Conversation is not confirmed idle|ChatGPT guest is not attached|ChatGPT page is unavailable before typing; no message sent|ChatGPT session registry is not hydrated; no message sent|Cannot send while session is|Queued attempt expired before (?:dispatch|typing); no message sent|Queued delivery expired during renderer preflight; no message sent|ChatGPT conversation not yet mounted with verified messages; original session retained, no message sent|Session URL, generation or guest changed before typing; refusing send|Unknown-send ledger changed before typing; aborting|The desktop app did not receive or complete the queued request in time|T3 Code is shutting down|Session bootstrap is awaiting its first assistant marker; no message sent|Session bootstrap ID mismatch:.*no message sent/i.test(
      response.message,
    )
  );
}

function missingRecipient(response: DesktopAppActivationResponse) {
  return (
    !response.ok &&
    response.message ===
      "T3 browser session is missing; original recipient retained, no message sent."
  );
}

function invalidRecipient(detail: string) {
  return /Conversation ID and expectedConversationId disagree/i.test(detail);
}

/** Accepted means persisted, never that a model read the message. */
export class ChatGPTDeliveryQueue {
  private readonly file: string;
  private readonly send: Sender;
  private readonly records = new Map<string, DeliveryRecord>();
  private readonly transitionListeners = new Set<(record: Omit<DeliveryRecord, "body">) => void>();
  private dispatchAllowed: (record: {messageId: string; sessionId: string}) => boolean = () => true;
  private dispatchAdmission: (record: {messageId: string; sessionId: string}) => Promise<boolean> = async () => true;
  private pulseActive = false;
  private readonly activeConversations = new Set<string>();
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private nextTry = new Map<string, number>();
  private lastScheduledConversation: string | undefined;
  private readonly notifyExhausted: (record: Omit<DeliveryRecord, "body">) => void;

  constructor(directory: string, send: Sender, notifyExhausted: (record: Omit<DeliveryRecord, "body">) => void = () => {}) {
    this.notifyExhausted = notifyExhausted;
    this.send = send;
    NodeFS.mkdirSync(directory, { recursive: true });
    this.file = NodePath.join(directory, "chatgpt-deliveries-v1.json");
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
        this.records.set(r.messageId, {
          ...r,
          status:
            r.status === "sending" ||
            (r.status === "needs_attention" &&
              r.attempts < MAX_DELIVERY_ATTEMPTS &&
              !invalidRecipient(r.lastError ?? "") &&
              !(r.draftRefusals && r.draftRefusals >= 3))
              ? "uncertain"
              : r.status,
          duplicateResends: r.duplicateResends ?? 0,
          draftRefusals: r.draftRefusals ?? 0,
        });
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

  /** Queued Caffy delivery is suspended with Keep T3 Busy / pause. All
   * ordinary T3 outbox traffic remains unaffected. */
  setDispatchPermission(check: (record: {messageId: string; sessionId: string}) => boolean) {
    this.dispatchAllowed = check;
  }
  setDispatchAdmission(check: (record: {messageId: string; sessionId: string}) => Promise<boolean>) {
    this.dispatchAdmission = check;
  }
  resumeAllowed() {
    void this.pulse().catch(() => {});
  }

  /** Retry deadlines are one-shot; new work and verified idle events trigger
   * immediate drains. No 3-second full-queue polling loop is needed. */
  private scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.closed || this.activeConversations.size >= MAX_ACTIVE_CONVERSATIONS)
      return;
    const seen = new Set<string>();
    let next = Number.POSITIVE_INFINITY;
    for (const record of this.records.values()) {
      if (
        record.status === "delivered" ||
        record.status === "cancelled" ||
        record.attempts >= MAX_DELIVERY_ATTEMPTS ||
        seen.has(record.conversationId)
      )
        continue;
      seen.add(record.conversationId);
      if (record.awaitingGuest || !this.dispatchAllowed(record)) continue;
      if (this.activeConversations.has(record.conversationId)) continue;
      next = Math.min(next, this.nextTry.get(record.messageId) ?? 0);
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

  /** A verified T3 idle edge releases ONLY this exact recipient lane. Queued
   * messages use the normal guarded submission; UNKNOWN never blindly resends. */
  onIdleTransition(event: { sessionId: string; conversationId: string }) {
    if (!this.started || this.closed || !isUuid(event.conversationId)) return;
    let ready = false;
    for (const record of this.records.values()) {
      if (
        record.sessionId !== event.sessionId ||
        record.conversationId !== event.conversationId ||
        !["queued", "uncertain"].includes(record.status)
      )
        continue;
      if (record.awaitingGuest) continue;
      this.nextTry.delete(record.messageId);
      ready = true;
    }
    if (ready) void this.pulse().catch(() => {});
  }

  /** Explicit observation from the renderer: resume only the exact conversation.
   * Repeated reports are safe and cannot send to another conversation. */
  onRecipientMounted(event: { sessionId: string; conversationId: string }) {
    if (!this.started || this.closed || !isUuid(event.conversationId)) return false;
    let ready = false;
    for (const record of this.records.values()) {
      if (record.sessionId !== event.sessionId || record.conversationId !== event.conversationId ||
          record.status !== "queued" || !record.awaitingGuest) continue;
      record.awaitingGuest = false;
      this.nextTry.delete(record.messageId);
      this.update(record, "queued");
      ready = true;
    }
    if (ready) void this.pulse().catch(() => {});
    return ready;
  }

  /** Called only after the queue has persisted a transition; no composer access. */
  subscribeTransitions(listener: (record: Omit<DeliveryRecord, "body">) => void) {
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

  enqueue(input: { messageId: string; sessionId: string; conversationId: string; body: string }) {
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
        existing.body !== input.body
      )
        throw new Error("Message ID already belongs to a different payload or recipient.");
      return this.publicRecord(existing);
    }
    const now = Date.now();
    const record: DeliveryRecord = {
      ...input,
      status: "queued",
      // Initial enqueue is not evidence of recipient readiness. Never submit
      // until the renderer observes the exact mounted, idle conversation.
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
    const active = all.filter((row) => row.status !== "delivered" && row.status !== "cancelled");
    const recent = all
      .filter((row) => row.status === "delivered" || row.status === "cancelled")
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
      (r) => r.conversationId === conversationId && !["delivered", "cancelled"].includes(r.status),
    );
    const attention = unresolved.filter((r) => r.status === "needs_attention").length;
    const head = unresolved[0];
    if (!head)
      return {
        conversationId,
        blocked: false as const,
        queuedBehind: 0,
        pending: unresolved.length,
        needsAttention: attention,
      };
    // Never expose body, renderer stack/error detail, or any composer content.
    const reason = head.lastError?.includes("Composer contains an existing draft")
      ? "recipient_draft_present"
      : head.status === "queued"
        ? head.awaitingGuest ? "guest_unmounted" : head.lastError?.includes("not confirmed idle")
          ? "recipient_not_confirmed_idle"
          : head.lastError?.includes("User-focused composer")
            ? "composer_user_focused"
            : head.lastError?.includes("Composer contains an existing draft")
              ? "recipient_draft_present"
              : /hibernated|not attached|not yet mounted/i.test(head.lastError ?? "")
                ? "guest_unmounted"
                : "awaiting_dispatch"
        : head.status === "needs_attention"
          ? "unverifiable_send_requires_resolution"
          : head.status === "uncertain" || head.status === "sending"
            ? "unknown_send_read_only_reconciliation"
            : "unresolved_delivery";
    return {
      conversationId,
      blocked: true as const,
      oldestMessageId: head.messageId,
      oldestStatus: head.status,
      oldestAgeMs: Math.max(0, now - head.createdAt),
      oldestAttempts: head.attempts,
      queuedBehind: unresolved.filter((r) => r !== head && r.status === "queued").length,
      pending: unresolved.length,
      needsAttention: attention,
      reason,
      nextStep:
        reason === "composer_user_focused"
          ? "wait_for_recipient_focus_release"
          : reason === "recipient_draft_present"
            ? "preserve_recipient_draft"
            : reason === "guest_unmounted"
              ? "wait_for_verified_recipient_mount"
              : reason === "recipient_not_confirmed_idle"
                ? "wait_for_recipient_idle"
                : head.status === "queued"
                  ? "verify_idle_recipient"
                  : "reconcile_then_retry_same_message",
    };
  }

  cancel(messageId: string) {
    const record = this.records.get(messageId);
    if (!record) throw new Error("Unknown delivery messageId.");
    if (record.status !== "queued")
      throw new Error("Only a not-yet-attempted queued message can be cancelled.");
    record.status = "cancelled";
    record.updatedAt = Date.now();
    this.save();
    this.notifyTransition(record);
    this.scheduleNext();
    return this.publicRecord(record);
  }

  private publicRecord(record: DeliveryRecord) {
    // Never expose full prompt contents through delivery status/logging.
    const { body: _body, ...result } = record;
    return result;
  }

  private update(record: DeliveryRecord, status: DeliveryState, error?: string) {
    record.status = status;
    record.updatedAt = Date.now();
    if (error === undefined) delete record.lastError;
    else record.lastError = error;
    this.save();
    this.notifyTransition(record);
  }

  private async dispatch(record: DeliveryRecord, action: "send" | "reconcile_send", retry = false) {
    // The most recent observed delivery can survive as composer residue after a restart.
    let previous: DeliveryRecord | undefined;
    for (const item of this.records.values()) {
      if (
        item.sessionId === record.sessionId &&
        item.conversationId === record.conversationId &&
        item.status === "delivered" &&
        item.messageId !== record.messageId &&
        item.createdAt <= record.createdAt &&
        (!previous || item.createdAt >= previous.createdAt)
      )
        previous = item;
    }
    const request: BrowserRequest = {
      version: 1,
      requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions",
      action,
      sessionId: record.sessionId,
      expectedConversationId: record.conversationId,
      ...(previous ? { previousDeliveredMessage: deliveryText(previous) } : {}),
      message: isWakeBody(record.body) || isCaffyWakeBody(record.body)
        ? record.body
        : `${MARKER(record.messageId)}\n${retry ? "[Potential duplicate: acknowledgement was lost. If you already handled this message ID, do not repeat its actions.]\n" : ""}${record.body}`,
      ...(retry ? { allowPossibleDuplicate: true } : {}),
      ...(record.sendExpiresAt ? { sendExpiresAt: record.sendExpiresAt } : {}),
    };
    return this.send(request);
  }

  /** Only the renderer's exact-conversation, actually-observed user turn is proof.
   * A generic successful IPC or messageSent flag is not enough to clear UNKNOWN. */
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
      data.verifiedConversationId === record.conversationId &&
      // A new send must report both facts; read-only reconciliation instead
      // proves an existing turn without issuing a send or setting messageSent.
      (record.status !== "sending" || ("messageSent" in data && data.messageSent === true))
    );
  }

  /** An exact renderer-owned pre-submit proof alone permits the original queued ID
   * to be retried. No other negative/UNKNOWN result may authorize a new click. */
  private provenNotSubmitted(
    record: DeliveryRecord,
    response: DesktopAppActivationResponse,
    requireExpiry = true,
  ): boolean {
    const data = response.ok && "data" in response ? response.data : null;
    return (
      (!requireExpiry || (!!record.sendExpiresAt && Date.now() > record.sendExpiresAt)) &&
      !!data &&
      typeof data === "object" &&
      "delivery" in data &&
      data.delivery === "pre_submit_aborted" &&
      "messageSent" in data &&
      data.messageSent === false &&
      "sendAttempted" in data &&
      data.sendAttempted === false &&
      "conversationGuardValidated" in data &&
      data.conversationGuardValidated === true &&
      "verifiedConversationId" in data &&
      data.verifiedConversationId === record.conversationId
    );
  }

  private async submit(record: DeliveryRecord, retry: boolean) {
    const previous = {
      lastSubmissionAt: record.lastSubmissionAt,
      sendExpiresAt: record.sendExpiresAt,
      duplicateResends: record.duplicateResends ?? 0,
    };
    record.lastSubmissionAt = Date.now();
    record.sendExpiresAt = Date.now() + 70_000;
    if (retry) record.duplicateResends = previous.duplicateResends + 1;
    this.update(record, "sending");
    const response = await this.dispatch(record, "send", retry);
    if (this.confirmed(record, response)) {
      record.observedDeliveryId = `${MARKER(record.messageId)}:user_turn_observed`;
      this.update(record, "delivered");
      return;
    }
    const detail = response.ok ? "Delivery not positively observed." : response.message;
    if (missingRecipient(response)) {
      Object.assign(record, previous);
      this.update(
        record,
        "cancelled",
        retry
          ? "Delivery dropped: recipient session is missing; an earlier submission may have occurred."
          : "Delivery dropped: recipient session is missing; this attempt was not sent.",
      );
      return;
    }
    if (refusedBeforeSubmission(response)) {
      if (/not (?:yet )?mounted|not attached|unavailable before typing|hibernated/i.test(detail)) {
        Object.assign(record, previous);
        record.awaitingGuest = true;
        this.nextTry.delete(record.messageId);
        this.update(record, "queued", "ChatGPT guest is not attached; awaiting verified mount.");
        return;
      }
      // A busy composer does not spend the duplicate retry budget or erase
      // uncertainty about an earlier submission.
      Object.assign(record, previous);
      const draftBlocked = detail.includes("Composer contains an existing draft");
      record.draftRefusals = draftBlocked ? (record.draftRefusals ?? 0) + 1 : 0;
      const needsDraftReview = draftBlocked && record.draftRefusals >= 3;
      this.update(
        record,
        needsDraftReview ? "needs_attention" : retry ? "uncertain" : "queued",
        detail,
      );
      this.nextTry.set(
        record.messageId,
        Date.now() + (needsDraftReview ? 5 * 60_000 : PREFLIGHT_RETRY_MS),
      );
      return;
    }
    if (this.provenNotSubmitted(record, response, false)) {
      // A direct React callback that was not available never touched the
      // composer or invoked submission. Requeue the same ID without UNKNOWN.
      Object.assign(record, previous);
      this.update(record, retry ? "uncertain" : "queued", "Renderer verified no submission.");
      this.nextTry.set(record.messageId, Date.now() + PREFLIGHT_RETRY_MS);
      return;
    }
    record.uncertainSince ??= record.lastSubmissionAt;
    this.update(record, invalidRecipient(detail) ? "needs_attention" : "uncertain", detail);
  }

  private async process(record: DeliveryRecord) {
    if (record.attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.update(record, "needs_attention", `Delivery stopped after ${record.attempts} attempts; retained for debugging.`);
      try { this.notifyExhausted(this.publicRecord(record)); } catch { /* notification failure must not resume retries */ }
      return;
    }
    record.attempts++;
    this.nextTry.set(record.messageId, Date.now() + RECONCILE_RETRY_MS);
    try {
      if (
        record.status === "queued" ||
        (record.status === "needs_attention" && (record.draftRefusals ?? 0) >= 3)
      ) {
        // Periodic exact guarded recovery, never overwriting any draft.
        await this.submit(record, false);
        return;
      }
      const response = await this.dispatch(record, "reconcile_send");
      if (this.confirmed(record, response)) {
        record.observedDeliveryId = `${MARKER(record.messageId)}:user_turn_observed`;
        this.update(record, "delivered");
        return;
      }
      if (missingRecipient(response)) {
        this.update(
          record,
          "cancelled",
          "Delivery dropped: recipient session is missing; an earlier submission may have occurred.",
        );
        return;
      }
      // An identity mismatch needs resolution; do not retarget or submit.
      if (record.status === "needs_attention") return;
      if ((record.duplicateResends ?? 0) === 0 && this.provenNotSubmitted(record, response)) {
        delete record.uncertainSince;
        this.update(record, "queued", "Renderer verified no submission before expiry.");
        this.nextTry.set(record.messageId, Date.now() + 3_000);
        return;
      }
      const detail = response.ok ? "Original user turn not positively observed." : response.message;
      if (invalidRecipient(detail)) {
        this.update(record, "needs_attention", detail);
        return;
      }
      record.uncertainSince ??= record.lastSubmissionAt ?? record.createdAt;
      if (isWakeBody(record.body) || isCaffyWakeBody(record.body)) {
        // The wake uses composer-free direct submission. Unknown means reconcile,
        // never submit another wake without proof the first was not sent.
        this.update(record, "uncertain", detail);
        return;
      }
      const retryCount = record.duplicateResends ?? 0;
      const retryDelay = DUPLICATE_RETRY_DELAYS_MS[retryCount];
      const retryDue =
        retryDelay !== undefined
          ? Date.now() - record.uncertainSince >= retryDelay
          : Date.now() - (record.lastSubmissionAt ?? record.createdAt) >= LONG_RETRY_MS;
      if (retryDue) {
        await this.submit(record, true);
      } else {
        this.update(record, "uncertain", detail);
      }
    } catch (error) {
      // A lost IPC acknowledgement is ambiguous. Preserve the persisted retry
      // count and reconcile before another possible submission.
      record.uncertainSince ??= record.lastSubmissionAt ?? record.createdAt;
      this.update(
        record,
        record.status === "needs_attention" ? "needs_attention" : "uncertain",
        String(error),
      );
    } finally {
      if (record.attempts >= MAX_DELIVERY_ATTEMPTS &&
          record.status !== "delivered" && record.status !== "cancelled" &&
          !record.awaitingGuest) {
        this.update(record, "needs_attention",
          `Delivery stopped after ${record.attempts} attempts; retained for debugging.`);
        try { this.notifyExhausted(this.publicRecord(record)); } catch { /* notification is advisory */ }
      }
    }
  }

  /** Independent conversations progress concurrently. Each lane preserves FIFO;
   * unresolved messages hold their own lane without blocking other recipients. */
  async pulse() {
    if (this.closed || this.pulseActive) return;
    this.pulseActive = true;
    try {
    const conversations = new Map<string, DeliveryRecord[]>();
    for (const record of this.records.values()) {
      if (record.status === "delivered" || record.status === "cancelled" || record.attempts >= MAX_DELIVERY_ATTEMPTS) continue;
      const group = conversations.get(record.conversationId) ?? [];
      group.push(record);
      conversations.set(record.conversationId, group);
    }
    const due = (record: DeliveryRecord) => (this.nextTry.get(record.messageId) ?? 0) <= Date.now();
    const work: Promise<void>[] = [];
    const lanes = [...conversations];
    const lastIndex = lanes.findIndex(([id]) => id === this.lastScheduledConversation);
    const ordered =
      lastIndex < 0 ? lanes : [...lanes.slice(lastIndex + 1), ...lanes.slice(0, lastIndex + 1)];
    for (const [conversationId, records] of ordered) {
      if (this.activeConversations.size >= MAX_ACTIVE_CONVERSATIONS) break;
      if (this.activeConversations.has(conversationId)) continue;
      const head = records[0];
      if (!head || head.awaitingGuest || !this.dispatchAllowed(head) || !due(head)) continue;
      // Revalidate queued-worker capacity immediately before the actual send.
      // This matters when manual sessions start after a wake was reserved.
      let admitted = false;
      try { admitted = await this.dispatchAdmission(head); } catch { admitted = false; }
      if (!admitted || !this.dispatchAllowed(head)) {
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
    await Promise.allSettled(work);
    } finally {
      this.pulseActive = false;
      this.scheduleNext();
    }
  }
}
