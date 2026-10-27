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
  /** When the last attempted submission began, including an ambiguous one. */
  lastSubmissionAt?: number;
  /** Start of the unresolved delivery, so retries keep their schedule after restart. */
  uncertainSince?: number;
  /** Renderer refuses a late first submission after this time; required for safe pre-submit recovery. */
  sendExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

type BrowserRequest = Extract<DesktopAppActivationRequest, { type: "chatgpt.sessions" }>;
type Sender = (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
const MARKER = (messageId: string) => `[T3-MSG:${messageId}]`;
// Reconcile first, then retry the SAME marked message at bounded intervals.
// Continue cautiously after the initial retries: a session may recover much later.
const DUPLICATE_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];
const LONG_RETRY_MS = 15 * 60_000;
const RECONCILE_RETRY_MS = 60_000;
const PREFLIGHT_RETRY_MS = 15_000;
const MAX_ACTIVE_CONVERSATIONS = 4;
const isUuid = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);

// These failures happen before the renderer touches the composer. Keep this
// legacy-text adapter here; arbitrary IPC errors can still follow a real send.
function refusedBeforeSubmission(response: DesktopAppActivationResponse) {
  return (
    !response.ok &&
    !/Outcome UNKNOWN|outcome indeterminate|may already have occurred/i.test(response.message) &&
    /User-focused composer before typing; no message sent|Automated composer ownership still active before typing; no message sent|Composer contains an existing draft; refusing to overwrite it|Conversation is not confirmed idle|ChatGPT guest is not attached|ChatGPT page is unavailable before typing; no message sent|ChatGPT session registry is not hydrated; no message sent|Cannot send while session is|Queued attempt expired before (?:dispatch|typing); no message sent|Queued delivery expired during renderer preflight; no message sent|ChatGPT conversation not yet mounted with verified messages; original session retained, no message sent|Session URL, generation or guest changed before typing; refusing send|Unknown-send ledger changed before typing; aborting|The desktop app did not receive or complete the queued request in time|T3 Code is shutting down/i.test(
      response.message,
    )
  );
}

function missingRecipient(response: DesktopAppActivationResponse) {
  return !response.ok && response.message === "T3 browser session is missing; original recipient retained, no message sent.";
}

function invalidRecipient(detail: string) {
  return /Conversation ID and expectedConversationId disagree/i.test(detail);
}

/** Accepted means persisted, never that a model read the message. */
export class ChatGPTDeliveryQueue {
  private readonly file: string;
  private readonly send: Sender;
  private readonly records = new Map<string, DeliveryRecord>();
  private readonly activeConversations = new Set<string>();
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextTry = new Map<string, number>();
  private lastScheduledConversation: string | undefined;

  constructor(directory: string, send: Sender) {
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
              !invalidRecipient(r.lastError ?? ""))
              ? "uncertain"
              : r.status,
          duplicateResends: r.duplicateResends ?? 0,
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
    if (this.timer) return;
    this.timer = setInterval(() => void this.pulse().catch(() => {}), 3000);
    this.timer.unref?.();
    void this.pulse().catch(() => {});
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
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
    if (this.timer) void this.pulse().catch(() => {});
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
    const reason =
      head.status === "queued"
        ? head.lastError?.includes("not confirmed idle")
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
  }

  private async dispatch(record: DeliveryRecord, action: "send" | "reconcile_send", retry = false) {
    const request: BrowserRequest = {
      version: 1,
      requestId: NodeCrypto.randomUUID(),
      type: "chatgpt.sessions",
      action,
      sessionId: record.sessionId,
      expectedConversationId: record.conversationId,
      message: `${MARKER(record.messageId)}\n${retry ? "[Potential duplicate: acknowledgement was lost. If you already handled this message ID, do not repeat its actions.]\n" : ""}${record.body}`,
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
  ): boolean {
    const data = response.ok && "data" in response ? response.data : null;
    return (
      !!record.sendExpiresAt &&
      Date.now() > record.sendExpiresAt &&
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
      this.update(record, "delivered");
      return;
    }
    const detail = response.ok ? "Delivery not positively observed." : response.message;
    if (missingRecipient(response)) {
      Object.assign(record, previous);
      this.update(record, "cancelled", retry
        ? "Delivery dropped: recipient session is missing; an earlier submission may have occurred."
        : "Delivery dropped: recipient session is missing; this attempt was not sent.");
      return;
    }
    if (refusedBeforeSubmission(response)) {
      // A busy composer does not spend the duplicate retry budget or erase
      // uncertainty about an earlier submission.
      Object.assign(record, previous);
      this.update(record, retry ? "uncertain" : "queued", detail);
      this.nextTry.set(record.messageId, Date.now() + PREFLIGHT_RETRY_MS);
      return;
    }
    record.uncertainSince ??= record.lastSubmissionAt;
    this.update(record, invalidRecipient(detail) ? "needs_attention" : "uncertain", detail);
  }

  private async process(record: DeliveryRecord) {
    record.attempts++;
    this.nextTry.set(record.messageId, Date.now() + RECONCILE_RETRY_MS);
    try {
      if (record.status === "queued") {
        await this.submit(record, false);
        return;
      }
      const response = await this.dispatch(record, "reconcile_send");
      if (this.confirmed(record, response)) {
        this.update(record, "delivered");
        return;
      }
      if (missingRecipient(response)) {
        this.update(record, "cancelled", "Delivery dropped: recipient session is missing; an earlier submission may have occurred.");
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
      const retryCount = record.duplicateResends ?? 0;
      const retryDelay = DUPLICATE_RETRY_DELAYS_MS[retryCount];
      const retryDue = retryDelay !== undefined
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
      this.update(record, record.status === "needs_attention" ? "needs_attention" : "uncertain", String(error));
    }
  }

  /** Independent conversations progress concurrently. Each lane preserves FIFO;
   * unresolved messages hold their own lane without blocking other recipients. */
  async pulse() {
    if (this.closed) return;
    const conversations = new Map<string, DeliveryRecord[]>();
    for (const record of this.records.values()) {
      if (record.status === "delivered" || record.status === "cancelled") continue;
      const group = conversations.get(record.conversationId) ?? [];
      group.push(record);
      conversations.set(record.conversationId, group);
    }
    const due = (record: DeliveryRecord) => (this.nextTry.get(record.messageId) ?? 0) <= Date.now();
    const work: Promise<void>[] = [];
    const lanes = [...conversations];
    const lastIndex = lanes.findIndex(([id]) => id === this.lastScheduledConversation);
    const ordered = lastIndex < 0 ? lanes : [...lanes.slice(lastIndex + 1), ...lanes.slice(0, lastIndex + 1)];
    for (const [conversationId, records] of ordered) {
      if (this.activeConversations.size >= MAX_ACTIVE_CONVERSATIONS) break;
      if (this.activeConversations.has(conversationId)) continue;
      const head = records[0];
      if (!head || !due(head)) continue;
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
  }
}
