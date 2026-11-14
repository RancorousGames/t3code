import type { DesktopChatGPTDeliveryDiagnostics } from "@t3tools/contracts";
import { ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

type Message = DesktopChatGPTDeliveryDiagnostics["messages"][number];
type Filter = Message["status"] | "all" | "new";
type Load =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; data: DesktopChatGPTDeliveryDiagnostics };

const STATES: readonly { id: Filter; label: string; detail: string }[] = [
  { id: "new", label: "New", detail: "Queued, never attempted" },
  { id: "queued", label: "Queued", detail: "Waiting for a dispatch slot or safe recipient" },
  { id: "sending", label: "Sending", detail: "Submission attempt in progress" },
  { id: "uncertain", label: "Pending / UNKNOWN", detail: "Checking if a turn appeared; may retry" },
  {
    id: "needs_attention",
    label: "Blocked",
    detail: "Recipient identity or delivery needs attention",
  },
  { id: "delivered", label: "Delivered", detail: "Exact user turn observed" },
  { id: "cancelled", label: "Cancelled", detail: "Recipient missing or queued item cancelled" },
];

function formatAge(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function PipelineNode({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count?: number | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{title}</span>
        {count !== undefined ? <strong className="tabular-nums">{count}</strong> : null}
      </div>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
      {children}
    </div>
  );
}

function StageArrow() {
  return (
    <ArrowRightIcon
      aria-hidden
      className="mx-auto size-4 shrink-0 text-muted-foreground max-md:rotate-90"
    />
  );
}

/** Purely observational view of the desktop main-process outbox; never sends or retries. */
export function MessagingDiagnosticsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    const read = window.desktopBridge?.readChatGPTDeliveryDiagnostics;
    if (!read) {
      setState({
        kind: "failed",
        message: "Messaging diagnostics require a current T3 desktop build.",
      });
      return;
    }
    setRefreshing(true);
    try {
      setState({ kind: "ready", data: await read() });
    } catch (error) {
      setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10_000);
    return () => clearInterval(interval);
  }, [open, refresh]);

  const data = state.kind === "ready" ? state.data : null;
  const now = data?.sampledAt ?? 0;
  const rows = useMemo(() => {
    if (!data) return [];
    return data.messages
      .filter(
        (row) =>
          filter === "all" ||
          (filter === "new"
            ? row.status === "queued" && row.attempts === 0
            : row.status === filter),
      )
      .sort((a, b) => {
        const pendingA = a.status !== "delivered" && a.status !== "cancelled";
        const pendingB = b.status !== "delivered" && b.status !== "cancelled";
        return Number(pendingB) - Number(pendingA) || a.createdAt - b.createdAt;
      });
  }, [data, filter]);

  const countFor = (key: Filter) => {
    if (!data) return 0;
    if (key === "all") return data.total;
    if (key === "new") return data.newCount;
    return data.counts[key];
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="flex max-h-[90dvh] w-[min(100%,1100px)] max-w-[1100px] flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3 pr-10">
            <DialogTitle>Messaging pipeline diagnostics</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : ""} /> Refresh
            </Button>
          </div>
          <DialogDescription>
            Live local T3 → ChatGPT browser delivery journal. Read-only; no message bodies, composer
            drafts, or private error text. Upstream messages not yet enqueued are not visible.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section aria-label="Message delivery flow" className="space-y-3">
            <div className="flex flex-col items-stretch gap-2 text-sm md:flex-row md:items-center">
              <PipelineNode
                title="Caller"
                subtitle="OmniHub / OpenRig / T3 requests; acceptance upstream not tracked here"
              />
              <StageArrow />
              <PipelineNode
                title="Durable outbox"
                subtitle="Message persisted by desktop main"
                count={data?.total}
              />
              <StageArrow />
              <PipelineNode
                title="Dispatch / preflight"
                subtitle="Recipient ready, draft and identity checks"
                count={data ? data.counts.queued + data.counts.sending : undefined}
              />
              <StageArrow />
              <PipelineNode
                title="ChatGPT turn"
                subtitle="Submit and reconcile exact user-turn observation"
                count={data ? data.counts.uncertain + data.counts.delivered : undefined}
              />
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Delivery outcomes / retries
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <PipelineNode
                  title="Observed"
                  subtitle="User turn verified in original conversation"
                  count={data?.counts.delivered}
                />
                <PipelineNode
                  title="Uncertain"
                  subtitle="Read-only reconciliation; later retry possible"
                  count={data?.counts.uncertain}
                />
                <PipelineNode
                  title="Needs attention"
                  subtitle="Manual resolution needed; no automatic retarget"
                  count={data?.counts.needs_attention}
                />
              </div>
            </div>
          </section>
          {state.kind === "failed" ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
            >
              {state.message}
            </p>
          ) : null}
          <section aria-label="Delivery states" className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Delivery states</h3>
              <span className="text-xs text-muted-foreground">
                {state.kind === "loading"
                  ? "Loading..."
                  : data
                    ? `Updated ${new Date(data.sampledAt).toLocaleTimeString()}`
                    : "Unavailable"}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {STATES.map((stage) => (
                <button
                  key={stage.id}
                  type="button"
                  aria-pressed={filter === stage.id}
                  onClick={() => setFilter(filter === stage.id ? "all" : stage.id)}
                  className={`rounded-lg border p-3 text-left transition-colors hover:bg-accent/50 ${filter === stage.id ? "border-primary bg-primary/10" : "border-border bg-card"}`}
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{stage.label}</span>
                    <strong className="tabular-nums">{countFor(stage.id)}</strong>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{stage.detail}</p>
                </button>
              ))}
            </div>
          </section>
          <section aria-label="Messages in the outbox" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                Messages {filter === "all" ? "(all)" : `(${filter})`}
              </h3>
              {filter !== "all" ? (
                <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
                  Clear filter
                </Button>
              ) : null}
            </div>
            <div className="max-h-[35dvh] space-y-2 overflow-y-auto">
              {rows.length ? (
                rows.map((row) => <MessageRow key={row.messageId} message={row} now={now} />)
              ) : (
                <p className="rounded-md border p-4 text-sm text-muted-foreground">
                  {data ? "No messages in this view." : "No snapshot available."}
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Showing up to 250 items: unresolved messages first, then the 50 most recent completed
              items. Status describes durable delivery, not assistant task completion.
            </p>
          </section>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MessageRow({ message, now }: { message: Message; now: number }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium capitalize">{message.status.replace("_", " ")}</span>
        <span className="text-muted-foreground">
          Age {formatAge(now - message.createdAt)} · Attempts {message.attempts}
          {message.queuedBehind ? ` · ${message.queuedBehind} queued behind` : ""}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span title={message.messageId}>
          Message <code>{message.messageId.slice(0, 8)}</code>
        </span>
        <span title={message.sessionId}>
          Session <code>{message.sessionId.slice(0, 8)}</code>
        </span>
        <span title={message.conversationId}>
          Conversation <code>{message.conversationId.slice(0, 8)}</code>
        </span>
      </div>
      {message.reason ? (
        <p className="mt-1 font-medium text-foreground">
          Head: {message.reason.replaceAll("_", " ")}
        </p>
      ) : null}
    </div>
  );
}
