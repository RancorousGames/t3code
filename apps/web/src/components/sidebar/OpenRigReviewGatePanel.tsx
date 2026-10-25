import {
  decodeOpenRigReviewGate,
  OPENRIG_REVIEW_GATE_VERDICTS,
  type DesktopOpenRigInboxItem,
  type DesktopOpenRigReviewGateResolveInput,
  type DesktopOpenRigReviewGateResolveResult,
  type OpenRigReviewGate,
  type OpenRigReviewGateVerdict,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

const PENDING_PREFIX = "t3code:openrig-review-gate-pending:v1:";
const newGateRequestId = () => {
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  return "gate-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};
const VERDICT_LABELS: Record<OpenRigReviewGateVerdict, string> = {
  approved: "Approve",
  changes_requested: "Request changes",
  rejected: "Reject",
};

/** An UNKNOWN release keeps its requestId so the only follow-up is a read-only receipt lookup. */
export function reviewGatePendingKey(gate: OpenRigReviewGate) {
  return PENDING_PREFIX + JSON.stringify([gate.gateQitemId, gate.reviewRevision]);
}
function readPending(key: string): DesktopOpenRigReviewGateResolveInput | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return value && typeof value === "object"
      ? (value as DesktopOpenRigReviewGateResolveInput)
      : null;
  } catch {
    return null;
  }
}
function writePending(key: string, value: DesktopOpenRigReviewGateResolveInput | null) {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch {
    /* session-only: reconciliation still works until reload */
  }
}

function describe(result: DesktopOpenRigReviewGateResolveResult) {
  if (result.outcome !== "released") return result.reason;
  const wake =
    result.delivery === "verified"
      ? "agent wake delivery verified (consumption not yet proven)"
      : result.delivery === "queued"
        ? "durable agent wake queued"
        : `agent wake ${result.delivery}`;
  return `Gate released durably (${result.status}) · ${wake}.`;
}

/** Linked TaskBoard review gate on an inbox item. Release always goes through desktop MAIN. */
export function OpenRigReviewGatePanel({
  item,
  address,
  onAnnouncement,
}: {
  item: DesktopOpenRigInboxItem;
  address: string;
  onAnnouncement: (message: string) => void;
}) {
  const gate = decodeOpenRigReviewGate(item.reviewGate);
  const pendingKey = gate ? reviewGatePendingKey(gate) : "";
  const [pending, setPending] = useState(() => (gate ? readPending(pendingKey) : null));
  const [verdict, setVerdict] = useState<OpenRigReviewGateVerdict | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hideThumbnail, setHideThumbnail] = useState(false);
  if (!gate) return null;

  const bridge = window.desktopBridge;
  const selection = {
    destination: "human@kernel" as const,
    qitemId: item.id,
    gateQitemId: gate.gateQitemId,
  };
  const operatorSeat = address === "human@kernel" && item.recipient === "human@kernel";
  const canResolve =
    operatorSeat && item.sourceType === "human_gate" && item.state === "blocked" &&
    !pending && !!bridge?.resolveOpenRigReviewGate;

  const settle = (result: DesktopOpenRigReviewGateResolveResult) => {
    const keep = result.outcome === "unknown" || result.outcome === "unconfirmed";
    if (!keep) {
      writePending(pendingKey, null);
      setPending(null);
    }
    setMessage(describe(result));
    onAnnouncement(describe(result));
  };

  const release = async () => {
    if (!verdict || !bridge?.resolveOpenRigReviewGate) return;
    const request: DesktopOpenRigReviewGateResolveInput = {
      ...selection,
      reviewId: gate.reviewId,
      reviewRevision: gate.reviewRevision,
      verdict,
      requestId: newGateRequestId(),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    // Persist before invoking so a crash mid-request can only reconcile, never resend.
    writePending(pendingKey, request);
    setPending(request);
    setBusy(true);
    try {
      settle(await bridge.resolveOpenRigReviewGate(request));
    } catch {
      setMessage("Release outcome unknown. Nothing will be resent; check status.");
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    if (!pending || !bridge?.reconcileOpenRigReviewGate) return;
    setBusy(true);
    try {
      settle(await bridge.reconcileOpenRigReviewGate(pending));
    } catch {
      setMessage("Receipt lookup unavailable. Try again later.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Linked TaskBoard review"
      className="mb-4 rounded-lg border border-border bg-muted/10 p-3 text-xs"
    >
      <div className="flex items-start gap-3">
        {gate.thumbnailUrl && !hideThumbnail && (
          <img
            src={gate.thumbnailUrl}
            alt=""
            className="h-16 w-24 shrink-0 rounded-md border border-border object-cover"
            referrerPolicy="no-referrer"
            onError={() => setHideThumbnail(true)}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{gate.title ?? "TaskBoard review"}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Review {gate.reviewId} · revision {gate.reviewRevision}
          </p>
          <span
            className={`mt-1.5 inline-flex rounded px-1.5 py-0.5 text-3xs font-semibold ${item.state === "blocked" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}`}
          >
            {item.state === "blocked" ? "Agent blocked on review gate" : "Gate released"}
          </span>
        </div>
        {gate.reviewUrl && bridge?.openOpenRigReviewGate && (
          <button
            type="button"
            aria-label="Open review in TaskBoard"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            onClick={() => {
              void bridge.openOpenRigReviewGate!(selection).then(
                (opened) => {
                  if (!opened) onAnnouncement("Review link unavailable.");
                },
                () => onAnnouncement("Review link unavailable."),
              );
            }}
          >
            <ExternalLinkIcon className="size-3.5" /> Open review
          </button>
        )}
      </div>

      {pending && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning"
        >
          <span className="min-w-0 flex-1">
            Release as "{VERDICT_LABELS[pending.verdict]}" is unconfirmed. Nothing will be resent.
          </span>
          {bridge?.reconcileOpenRigReviewGate && (
            <button
              type="button"
              disabled={busy}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
              onClick={() => void reconcile()}
            >
              Check status
            </button>
          )}
          {/* Way out of a stuck record. MAIN still refuses a second release once
              OpenRig reports the gate released, so this cannot double-release. */}
          <button
            type="button"
            disabled={busy}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            onClick={() => {
              writePending(pendingKey, null);
              setPending(null);
              setMessage(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {canResolve && (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <div role="group" aria-label="Review verdict" className="flex flex-wrap gap-1">
            {OPENRIG_REVIEW_GATE_VERDICTS.map(
              (option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={verdict === option}
                  className={`rounded-md px-2 py-1.5 text-2xs font-medium ${verdict === option ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  onClick={() => setVerdict(option)}
                >
                  {VERDICT_LABELS[option]}
                </button>
              ),
            )}
          </div>
          <textarea
            aria-label="Optional note for the agent"
            placeholder="Optional note"
            maxLength={2000}
            rows={2}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-3xs text-muted-foreground">
              Open the review before releasing.
              Desktop asks you to confirm before anything is sent.
            </p>
            <button
              type="button"
              disabled={!verdict || busy}
              className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={() => void release()}
            >
              Release gate…
            </button>
          </div>
        </div>
      )}

      {item.state === "blocked" && !canResolve && !pending && (
        <p className="mt-3 text-3xs text-muted-foreground">
          {operatorSeat && !bridge?.resolveOpenRigReviewGate
            ? "This desktop build cannot release review gates."
            : "Only the local operator seat can release this gate."}
        </p>
      )}
      {message && <p className="mt-2 text-2xs text-muted-foreground">{message}</p>}
    </section>
  );
}
