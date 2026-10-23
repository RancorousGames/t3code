import type {
  DesktopOpenRigInboxItem,
  DesktopOpenRigOperatorReplyResult,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";

const PREFIX = "t3code:openrig-human-reply-draft:v1:";
const MAX_REPLY = 4_000;

type InboxItem = DesktopOpenRigInboxItem;

/**
 * An adapter may be passed only after OpenRig exposes an authenticated,
 * operator-origin reply route. The backend must derive/authorize the sender,
 * honor operationId idempotently, and return a durable source-linked receipt.
 * This is deliberately NOT the managed-seat /agents/:id/send bridge.
 */
export interface HumanReplyRequest {
  operationId: string;
  sourceType: InboxItem["sourceType"];
  sourceId: string;
  replyTo: string;
  from: string;
  to: string;
  body: string;
}

export type HumanReplySend = (
  request: HumanReplyRequest,
) => Promise<DesktopOpenRigOperatorReplyResult>;
export type HumanReplyReconcile = HumanReplySend;

interface StoredDraft {
  text: string;
  attempt: { operationId: string; state: "unknown" | "accepted" } | null;
}

function keyFor(address: string, item: InboxItem): string {
  // Distinct mailbox / queue IDs (including same-ID collisions) and human seats.
  return PREFIX + JSON.stringify([address, item.sourceType, item.id, item.sender]);
}

function readDraft(key: string): StoredDraft {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const data = raw as Record<string, unknown>;
      const attempt = data.attempt;
      const storedAttempt =
        attempt && typeof attempt === "object" && !Array.isArray(attempt)
          ? (attempt as Record<string, unknown>)
          : null;
      return {
        text: typeof data.text === "string" ? data.text.slice(0, MAX_REPLY) : "",
        attempt:
          storedAttempt &&
          typeof storedAttempt.operationId === "string" &&
          (storedAttempt.state === "unknown" || storedAttempt.state === "accepted")
            ? { operationId: storedAttempt.operationId, state: storedAttempt.state }
            : null,
      };
    }
  } catch {
    // Storage may be disabled; keep an in-memory draft but never claim persistence.
  }
  return { text: "", attempt: null };
}

function saveDraft(key: string, draft: StoredDraft): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function humanReplyCopyText(address: string, item: InboxItem, body: string): string {
  return `From: ${address}\nTo: ${item.sender}\nIn reply to: ${item.sourceType}/${item.id}\n\n${body}`;
}

function receiptMatches(
  request: HumanReplyRequest,
  receipt: DesktopOpenRigOperatorReplyResult,
): boolean {
  return (
    receipt.outcome === "accepted" &&
    receipt.acceptedIntoQueue === true &&
    receipt.deliveredToAgent === false &&
    receipt.requestId === request.operationId &&
    receipt.qitemId === request.sourceId &&
    receipt.source === request.from &&
    receipt.recipient === request.to &&
    receipt.replyQitemId.length > 0
  );
}

export function OpenRigHumanReplyComposer({
  item,
  address,
  onSend,
  onReconcile,
  unavailableReason,
  onAnnouncement,
}: {
  item: InboxItem;
  address: string;
  onSend?: HumanReplySend;
  onReconcile?: HumanReplyReconcile;
  unavailableReason?: string;
  onAnnouncement?: (text: string) => void;
}) {
  return (
    <ReplyComposer
      key={keyFor(address, item)}
      item={item}
      address={address}
      {...(onSend ? { onSend } : {})}
      {...(onReconcile ? { onReconcile } : {})}
      {...(unavailableReason ? { unavailableReason } : {})}
      {...(onAnnouncement ? { onAnnouncement } : {})}
    />
  );
}

function ReplyComposer({
  item,
  address,
  onSend,
  onReconcile,
  unavailableReason,
  onAnnouncement,
}: {
  item: InboxItem;
  address: string;
  onSend?: HumanReplySend;
  onReconcile?: HumanReplyReconcile;
  unavailableReason?: string;
  onAnnouncement?: (text: string) => void;
}) {
  const key = keyFor(address, item);
  const [draft, setDraft] = useState<StoredDraft>(() => readDraft(key));
  const [stored, setStored] = useState(() => {
    try {
      return window.localStorage !== undefined;
    } catch {
      return false;
    }
  });
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
  const canSubmit = Boolean(
    onSend && stored && !sending && !busy.current && !draft.attempt && draft.text.trim(),
  );

  function update(text: string) {
    const next = { ...draft, text: text.slice(0, MAX_REPLY) };
    setDraft(next);
    setStored(saveDraft(key, next));
    setNotice("");
  }

  async function copy() {
    if (!draft.text.trim()) {
      setNotice("Write a reply before copying.");
      return;
    }
    try {
      await navigator.clipboard.writeText(humanReplyCopyText(address, item, draft.text));
      const message = "Reply copied with original sender and message ID. Nothing was sent.";
      setNotice(message);
      onAnnouncement?.(message);
    } catch {
      setNotice("Copy failed. Select the draft text to copy manually; nothing was sent.");
    }
  }

  function requestFor(operationId: string): HumanReplyRequest {
    return {
      operationId,
      sourceType: item.sourceType,
      sourceId: item.id,
      replyTo: item.id,
      from: address,
      to: item.sender,
      body: draft.text,
    };
  }

  function accept(operationId: string, text: string) {
    const accepted: StoredDraft = { text, attempt: { operationId, state: "accepted" } };
    setStored(saveDraft(key, accepted));
    setDraft(accepted);
    setNotice(
      "OpenRig durably accepted this reply into its queue; agent consumption is unverified.",
    );
    onAnnouncement?.("Reply accepted into OpenRig queue; agent delivery is not implied.");
  }

  async function submit() {
    if (!canSubmit || !onSend || busy.current) return;
    busy.current = true;
    const request = requestFor(randomUUID());
    // Persist the in-flight operation BEFORE transport. An unknown result (including
    // a component reload or malformed receipt) must never silently create a retry.
    const pending: StoredDraft = {
      text: draft.text,
      attempt: { operationId: request.operationId, state: "unknown" },
    };
    if (!saveDraft(key, pending)) {
      busy.current = false;
      setStored(false);
      setNotice("Not sent: local operation record could not be saved.");
      return;
    }
    setDraft(pending);
    setSending(true);
    try {
      const receipt = await onSend(request);
      if (receiptMatches(request, receipt)) {
        accept(request.operationId, request.body);
      } else if (receipt.outcome === "not_sent") {
        const retryable: StoredDraft = { text: request.body, attempt: null };
        setStored(saveDraft(key, retryable));
        setDraft(retryable);
        setNotice("Not sent (before POST or authoritative rejection): " + receipt.reason);
      } else {
        setNotice("Outcome unknown. No repeat POST. Check the exact recorded operation.");
      }
    } catch {
      setNotice("Reply outcome unknown. No repeat POST; check the exact operation.");
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  async function reconcile() {
    if (!draft.attempt || draft.attempt.state !== "unknown" || !onReconcile || busy.current) return;
    busy.current = true;
    setSending(true);
    const request = requestFor(draft.attempt.operationId);
    try {
      const receipt = await onReconcile(request);
      if (receiptMatches(request, receipt)) accept(request.operationId, request.body);
      else setNotice("No matching durable receipt confirmed yet. Do not resend.");
    } catch {
      setNotice("Receipt lookup unavailable. Do not resend.");
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  const blocked =
    draft.attempt?.state === "unknown"
      ? "Outcome unknown — do not resend until the exact operation is reconciled."
      : draft.attempt?.state === "accepted"
        ? "Reply recorded by OpenRig. Agent delivery is not implied."
        : !onSend
          ? (unavailableReason ??
            "Sending unavailable: backend writer capability not confirmed. Local draft only.")
          : !stored
            ? "Local draft storage unavailable. Sending requires a persisted operation ID."
            : "An exact OpenRig durable acceptance receipt is required before a reply counts as sent.";

  return (
    <section
      aria-label="Reply to OpenRig message"
      className="space-y-2 rounded-lg border border-border bg-muted/20 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Reply</h3>
        <span className="text-2xs text-muted-foreground">Local draft · not an agent command</span>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        From: {address} · To: {item.sender} · {item.sourceType}/{item.id}
      </p>
      <textarea
        aria-label="Ordinary OpenRig reply draft"
        className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        placeholder="Write your reply…"
        maxLength={MAX_REPLY}
        value={draft.text}
        disabled={sending || draft.attempt !== null}
        onChange={(event) => update(event.currentTarget.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
        >
          Copy reply
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "Submitting…" : "Submit reply"}
        </button>
        {draft.attempt?.state === "unknown" && onReconcile && (
          <button
            type="button"
            disabled={sending}
            onClick={() => void reconcile()}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
          >
            Check receipt (read-only)
          </button>
        )}
        <span className="text-2xs text-muted-foreground">
          {stored ? "Draft saved on this device" : "Storage unavailable — copy your draft"}
        </span>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {notice || blocked}
      </p>
    </section>
  );
}
