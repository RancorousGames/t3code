import type { DesktopOpenRigNativeApproval, DesktopOpenRigNativeReviewResult } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { formatTimestamp } from "./openRigAgentPresentation";
import { isCostlyModel, readCostlyPatterns } from "./openRigCostPolicy";

/**
 * Display of OpenRig spawn-approval requests (policy:
 * OpenRig docs/as-built/openrig-t3-spawn-approval-policy-20261019.md).
 *
 * PROPOSED renderer shape, pending the IPC contract with the T3/OpenRig
 * owners; it is deliberately not in packages/contracts yet. No endpoint exists
 * today, so live surfaces render SPAWN_APPROVAL_FEED_UNAVAILABLE. Decision
 * buttons render only when a trusted, privileged decision function is passed;
 * nothing passes one until the protected writer exists. There is no
 * client-side approval state.
 */
export type SpawnApprovalStatus =
  | "requested"
  | "pending_approval"
  | "approved"
  | "denied"
  | "expired"
  | "reserved_for_execution"
  | "launched"
  | "indeterminate";

export interface SpawnApprovalRequestView {
  id: string;
  operationId: string;
  status: SpawnApprovalStatus;
  /** Only a server-verified caller seat; anything else is unknown. */
  requestedBy: { kind: "verified-seat"; seatId: string } | { kind: "unknown" };
  /** Present only when the server proved the originating thread AND environment. */
  sourceThread: { environmentId: string; threadId: string } | null;
  /** A verified source thread ID whose environment was not supplied. */
  verifiedSourceThreadId?: string | null;
  descriptorSha256?: string;
  stateVersion?: number;
  destinationSeatId: string | null;
  target: {
    environmentId: string;
    providerInstanceId: string;
    model: string;
    effort: string | null;
    runtime: string;
    runtimeMode: string;
  };
  /** Server-resolved from the authoritative catalog; never from the claimed model string. */
  exemption: "exempt-verified-luna" | "not-exempt" | "unknown";
  workspaceRoot: string | null;
  projectId: string | null;
  /** Bounded human-facing preview; never the full prompt. */
  taskPreview: string | null;
  requestedAt: string;
  expiresAt: string | null;
  decision: { outcome: "approved" | "denied"; actor: string; at: string } | null;
}

export type SpawnApprovalFeed =
  | { kind: "unavailable"; reason: string }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; requests: readonly SpawnApprovalRequestView[] };

/** Renderer asks MAIN to open a native review by opaque ID; no approval choice travels here. */
export type SpawnNativeReview = (operationId: string) => Promise<DesktopOpenRigNativeReviewResult>;

export const SPAWN_APPROVAL_FEED_UNAVAILABLE: SpawnApprovalFeed = {
  kind: "unavailable",
  reason:
    "OpenRig has no spawn-approval endpoint yet and the policy is not enforced. Agent-initiated native sessions can currently start without approval.",
};

const STATUS: Record<SpawnApprovalStatus, { label: string; variant: "warning" | "success" | "info" | "error" | "outline" }> = {
  requested: { label: "Requested", variant: "outline" },
  pending_approval: { label: "Pending approval", variant: "warning" },
  approved: { label: "Approved once", variant: "success" },
  reserved_for_execution: { label: "Reserved for launch", variant: "info" },
  launched: { label: "Launched", variant: "success" },
  denied: { label: "Denied", variant: "error" },
  expired: { label: "Expired", variant: "outline" },
  indeterminate: { label: "Outcome indeterminate", variant: "error" },
};

function relative(fromMs: number, toIso: string): string {
  const minutes = Math.round((Date.parse(toIso) - fromMs) / 60_000);
  if (!Number.isFinite(minutes)) return toIso;
  const span = Math.abs(minutes) < 60 ? `${Math.abs(minutes)} min` : `${Math.round(Math.abs(minutes) / 60)} h`;
  return minutes >= 0 ? `in ${span}` : `${span} ago`;
}

export function SpawnApprovalCard({
  request,
  seatName,
  now,
  onReview,
}: {
  request: SpawnApprovalRequestView;
  seatName: (seatId: string) => string;
  /** Render-time clock; the card does not tick on its own. */
  now: number;
  onReview?: SpawnNativeReview;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>("");
  const status = STATUS[request.status];
  const expired = request.expiresAt !== null && Date.parse(request.expiresAt) <= now;
  const reviewable = Boolean(onReview) && request.status === "pending_approval" && !expired;
  const costly = isCostlyModel(request.target.model, readCostlyPatterns());

  async function review() {
    if (!onReview || busy) return;
    setBusy(true);
    setResult("");
    try {
      const outcome = await onReview(request.operationId);
      setResult(outcome.outcome === "recorded" && outcome.item
        ? `Canonical decision status: ${outcome.item.status}. Execution is still blocked pending server-side release.`
        : outcome.outcome === "verification-unavailable"
          ? "Windows Hello verification unavailable. No decision was recorded."
          : "Native review cancelled. No decision was recorded.");
    } catch (error) {
      setResult(`Native review outcome unconfirmed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}. Inspect the canonical operation; do not retry automatically.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-label={`Spawn approval request ${request.operationId.slice(0, 8)}: ${status.label}`}
      className={`space-y-1.5 rounded-xl border px-3 py-2.5 text-xs ${request.status === "pending_approval" && !expired ? "border-warning/50 bg-warning/6" : "border-border"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={expired && request.status === "pending_approval" ? "outline" : status.variant}>
          {expired && request.status === "pending_approval" ? "Expired" : status.label}
        </Badge>
        <span className="font-medium">
          {request.requestedBy.kind === "verified-seat" ? seatName(request.requestedBy.seatId) : "Unknown caller (unverified)"}
          {" → "}
          {request.destinationSeatId ? seatName(request.destinationSeatId) : "no seat"}
        </span>
        <span className="text-2xs text-muted-foreground">requested {relative(now, request.requestedAt)}</span>
        {request.expiresAt && request.status === "pending_approval" && !expired && (
          <span className="text-2xs text-warning">expires {relative(now, request.expiresAt)}</span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-2xs">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="flex flex-wrap items-center gap-1">
          {request.target.model}{request.target.effort ? ` · effort ${request.target.effort}` : ""}
          {costly && <Badge variant="warning" size="sm">Costly</Badge>}
          {request.exemption === "not-exempt" && <Badge variant="outline" size="sm">Not exempt</Badge>}
          {request.exemption === "unknown" && <Badge variant="outline" size="sm">Exemption unverified</Badge>}
        </dd>
        <dt className="text-muted-foreground">Provider</dt>
        <dd>{request.target.providerInstanceId} · {request.target.runtime} · {request.target.runtimeMode}</dd>
        <dt className="text-muted-foreground">Workspace</dt>
        <dd className="break-all">{request.workspaceRoot ?? request.projectId ?? "not recorded"}</dd>
        <dt className="text-muted-foreground">Source thread</dt>
        <dd className="break-all">{request.sourceThread ? request.sourceThread.threadId : request.verifiedSourceThreadId ? `${request.verifiedSourceThreadId} (environment not recorded)` : "not proven"}</dd>
        <dt className="text-muted-foreground">Operation</dt>
        <dd className="font-mono" aria-label={`Operation ${request.operationId}`}>{request.operationId}</dd>
        {request.stateVersion !== undefined && <><dt className="text-muted-foreground">Canonical version</dt><dd>{request.stateVersion}</dd></>}
        {request.descriptorSha256 && <><dt className="text-muted-foreground">Descriptor digest</dt><dd className="break-all font-mono">{request.descriptorSha256}</dd></>}
      </dl>
      {request.taskPreview && <p className="line-clamp-3 break-words text-2xs text-muted-foreground">Task: {request.taskPreview}</p>}
      {request.decision && (
        <p className="text-2xs text-muted-foreground">
          {request.decision.outcome === "approved" ? "Approved" : "Denied"} by {request.decision.actor} {formatTimestamp(request.decision.at)}
        </p>
      )}
      {request.status === "indeterminate" && (
        <p role="alert" className="text-2xs text-destructive">Launch outcome is unknown. It will not be retried; inspect the provider before any new request.</p>
      )}
      {costly && request.status === "pending_approval" && !expired && (
        <p className="text-2xs text-warning">Flagged as costly on this device. T3 cannot show its price.</p>
      )}
      {reviewable && (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void review()}>
          {busy ? "Opening native review…" : "Review in native desktop dialog"}
        </Button>
      )}
      {result && <p role="status" className="text-2xs">{result}</p>}
    </article>
  );
}

/** Spawn approvals for one seat (as requester or destination), or all seats when seatId is null. */
export function OpenRigSpawnApprovalPanel({
  feed,
  seatId,
  seatName,
  onReview,
}: {
  feed: SpawnApprovalFeed;
  seatId: string | null;
  seatName: (seatId: string) => string;
  onReview?: SpawnNativeReview;
}) {
  const now = Date.now();
  if (feed.kind === "unavailable")
    return (
      <div role="status" className="space-y-1 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-2xs leading-relaxed">
        <p className="font-semibold">Spawn approval: not enforced yet</p>
        <p>{feed.reason}</p>
        <p className="text-muted-foreground">
          Policy: agent-initiated native sessions need human approval unless the model is server-verified GPT-6 Luna; ChatGPT
          browser sessions are exempt. This is separate from a session&apos;s runtime approval mode.
        </p>
      </div>
    );
  if (feed.kind === "loading") return <p role="status" className="text-2xs text-muted-foreground">Loading spawn approvals…</p>;
  if (feed.kind === "error")
    return <p role="alert" className="text-2xs text-destructive">Spawn approvals unavailable: {feed.message}</p>;
  const requests = feed.requests.filter((request) =>
    seatId === null || request.destinationSeatId === seatId ||
    (request.requestedBy.kind === "verified-seat" && request.requestedBy.seatId === seatId));
  if (requests.length === 0)
    return <p className="text-2xs text-muted-foreground italic">No spawn approval requests{seatId ? " for this seat" : ""}.</p>;
  const pending = requests.filter((request) => request.status === "pending_approval");
  return (
    <div className="space-y-2">
      {pending.length > 0 && <p className="text-2xs font-semibold text-warning">{pending.length} waiting for a decision</p>}
      {requests.map((request) => (
        <SpawnApprovalCard key={request.id} request={request} seatName={seatName} now={now} {...(onReview ? { onReview } : {})} />
      ))}
    </div>
  );
}


/** Never infer a verified source environment, caller seat, destination or exemption
 * from a model string. All data comes from the canonical authority projection. */
export function canonicalApprovalToView(item: DesktopOpenRigNativeApproval): SpawnApprovalRequestView {
  return {
    id: item.id,
    operationId: item.operationId,
    descriptorSha256: item.descriptorSha256,
    stateVersion: item.stateVersion,
    status: item.status,
    requestedBy: item.requester.verified && item.requester.callerSeatId
      ? { kind: "verified-seat", seatId: item.requester.callerSeatId }
      : { kind: "unknown" },
    sourceThread: null,
    verifiedSourceThreadId: item.requester.verified ? item.requester.sourceThreadId : null,
    destinationSeatId: null,
    target: {
      environmentId: item.target.environmentId,
      providerInstanceId: item.target.providerInstanceId,
      model: item.target.modelSlug,
      effort: item.target.reasoningEffort,
      runtime: item.target.driver,
      runtimeMode: item.target.runtimeMode,
    },
    exemption: "unknown",
    workspaceRoot: item.target.workspaceRoot,
    projectId: item.target.projectId,
    taskPreview: item.task.preview,
    requestedAt: item.requestedAt,
    expiresAt: item.expiresAt,
    decision: null,
  };
}

/** Shared Inbox / Agent Network / requester-seat view. No client-side approval
 * state: native review is requested by opaque operationId only, and its result
 * is read back from the canonical authority. */
export function OpenRigCanonicalSpawnApprovals({
  seatId,
  seatName,
}: {
  seatId: string | null;
  seatName: (seatId: string) => string;
}) {
  const [feed, setFeed] = useState<SpawnApprovalFeed>({ kind: "loading" });
  const [recent, setRecent] = useState<readonly DesktopOpenRigNativeApproval[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const canReview = Boolean(window.desktopBridge?.requestOpenRigNativeReview);
  const refresh = useCallback(async () => {
    const bridge = window.desktopBridge;
    const load = bridge?.listPendingOpenRigNativeApprovals;
    if (!load) {
      setFeed(SPAWN_APPROVAL_FEED_UNAVAILABLE);
      return;
    }
    setRefreshing(true);
    try {
      const page = await load();
      // A pending page is a read, not a human approval, reservation or proof
      // that native creation is now enforced in the running T3 executable.
      if (page.source !== "openrig-canonical-sqlite" || page.address !== "human@kernel" ||
          page.decisionWriteAvailable !== false || page.executionReserveAvailable !== false ||
          page.items.length > 50 || page.count < page.items.length) {
        throw new Error("Inconsistent canonical approval read; no decision was requested.");
      }
      const ids = new Set(page.items.map((item) => item.operationId));
      const get = bridge.getOpenRigNativeApproval;
      const settled = get ? await Promise.all(recent.slice(-8).filter((item) => !ids.has(item.operationId))
        .map(async (item) => get(item.operationId).catch(() => null))) : [];
      const items = [...page.items, ...settled.filter((item): item is DesktopOpenRigNativeApproval => item !== null)];
      setFeed({ kind: "ready", requests: items.map(canonicalApprovalToView) });
      setTruncated(page.truncated);
      setLastRead(new Date().toISOString());
    } catch (error) {
      setFeed({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRefreshing(false);
    }
  }, [recent]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    const timer = window.setInterval(() => { void refresh(); }, 45_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const review = useCallback(async (operationId: string) => {
    const request = window.desktopBridge?.requestOpenRigNativeReview;
    if (!request) throw new Error("Native MAIN review is unavailable on this desktop.");
    // NO renderer choice, actionId, digest, asserted human state or token.
    const result = await request(operationId);
    if (result.item) {
      if (result.item.operationId !== operationId)
        throw new Error("Canonical review returned the wrong operation. Do not retry automatically.");
      setRecent((prior) =>
        [result.item!, ...prior.filter((item) => item.operationId !== operationId)].slice(0, 8));
    }
    return result;
  }, []);

  return (
    <section aria-label="Canonical native spawn approvals" className="space-y-2">
      <div role="status" className="rounded-md border border-warning/50 bg-warning/8 px-3 py-2 text-2xs">
        <strong>Native approval release: RED.</strong>{" "}
        Source-only review wiring is not deployed or certified. A recorded human decision does not
        launch a thread or release the server-side guard; exact per-child reservation, provider SDK
        coverage and production attestation remain unverified.
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-muted-foreground">
          {lastRead ? `Canonical read ${formatTimestamp(lastRead)}` : "Canonical approval feed not yet confirmed"}
          {truncated ? " · More requests exist beyond this page" : ""}
        </span>
        <Button size="xs" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Reading…" : "Refresh approvals"}
        </Button>
      </div>
      <OpenRigSpawnApprovalPanel feed={feed} seatId={seatId} seatName={seatName}
        {...(canReview ? { onReview: review } : {})} />
    </section>
  );
}
