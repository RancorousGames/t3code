import type { DesktopOpenRigInboxItem } from "@t3tools/contracts";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";

const PREFIX = "t3code:openrig-human-reply-draft:v1:";
const MAX_REPLY = 8_000;

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

export interface HumanReplyReceipt {
  acceptedIntoQueue: true;
  durable: true;
  operationId: string;
  sourceType: InboxItem["sourceType"];
  sourceId: string;
  replyTo: string;
  from: string;
  to: string;
  replyId: string;
}

export type HumanReplySend = (request: HumanReplyRequest) => Promise<HumanReplyReceipt>;

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

function receiptMatches(request: HumanReplyRequest, receipt: HumanReplyReceipt): boolean {
  return (
    receipt.acceptedIntoQueue === true &&
    receipt.durable === true &&
    typeof receipt.replyId === "string" &&
    receipt.replyId.length > 0 &&
    receipt.operationId === request.operationId &&
    receipt.sourceType === request.sourceType &&
    receipt.sourceId === request.sourceId &&
    receipt.replyTo === request.replyTo &&
    receipt.from === request.from &&
    receipt.to === request.to
  );
}

export function OpenRigHumanReplyComposer({
  item,
  address,
  onSend,
  onAnnouncement,
}: {
  item: InboxItem;
  address: string;
  onSend?: HumanReplySend;
  onAnnouncement?: (text: string) => void;
}) {
  return (
    <ReplyComposer
      key={keyFor(address, item)}
      item={item}
      address={address}
      {...(onSend ? { onSend } : {})}
      {...(onAnnouncement ? { onAnnouncement } : {})}
    />
  );
}

function ReplyComposer({
  item,
  address,
  onSend,
  onAnnouncement,
}: {
  item: InboxItem;
  address: string;
  onSend?: HumanReplySend;
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
  const [notice, setNotice] = useState("");
  const canSubmit = Boolean(onSend && stored && !sending && !draft.attempt && draft.text.trim());

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

  async function submit() {
    if (!canSubmit || !onSend) return;
    const request: HumanReplyRequest = {
      operationId: randomUUID(),
      sourceType: item.sourceType,
      sourceId: item.id,
      replyTo: item.id,
      from: address,
      to: item.sender,
      body: draft.text,
    };
    // Persist the in-flight operation BEFORE transport. An unknown result (including
    // a component reload or malformed receipt) must never silently create a retry.
    const pending: StoredDraft = {
      text: draft.text,
      attempt: { operationId: request.operationId, state: "unknown" },
    };
    if (!saveDraft(key, pending)) {
      setStored(false);
      setNotice("Not sent: local operation record could not be saved.");
      return;
    }
    setDraft(pending);
    setSending(true);
    try {
      const receipt = await onSend(request);
      if (!receiptMatches(request, receipt))
        throw new Error("OpenRig did not confirm the exact durable reply identity.");
      const accepted: StoredDraft = {
        ...pending,
        attempt: { operationId: request.operationId, state: "accepted" },
      };
      setStored(saveDraft(key, accepted));
      setDraft(accepted);
      setNotice(
        "OpenRig durably accepted this reply into its queue; agent consumption is unverified.",
      );
      onAnnouncement?.("Reply accepted into OpenRig queue; agent delivery is not implied.");
    } catch {
      setNotice(
        "Reply outcome unknown. Draft retained; inspect the exact OpenRig operation before any retry.",
      );
    } finally {
      setSending(false);
    }
  }

  const blocked =
    draft.attempt?.state === "unknown"
      ? "Outcome unknown — do not resend until the exact operation is reconciled."
      : draft.attempt?.state === "accepted"
        ? "Reply recorded by OpenRig. Agent delivery is not implied."
        : !onSend
          ? "Sending unavailable: OpenRig has no supported ordinary human Reply endpoint yet. This is a local draft only."
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
        disabled={sending || draft.attempt?.state === "accepted"}
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
