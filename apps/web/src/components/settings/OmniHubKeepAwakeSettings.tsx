import { AlertTriangleIcon, CheckIcon, CopyIcon, ExternalLinkIcon, InfoIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { formatRelativeTimeLabel, formatRelativeTimeUntil } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  formatKeepAwakeInterval,
  formatKeepAwakeRawValue,
  getOmniHubKeepAwakeReader,
  groupKeepAwakeMonitors,
  isFinalWakeOverdue,
  keepAwakeHasIssue,
  keepAwakeStatusPresentation,
  type OmniHubKeepAwakeMonitor,
  type OmniHubKeepAwakeReadResult,
  type OmniHubKeepAwakeReader,
  type OmniHubKeepAwakeTarget,
} from "./omniHubKeepAwake.logic";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

// Snapshots are cheap local reads; 15s keeps "next attempt" honest without
// polling hard. Polling pauses while the window is hidden.
const AUTO_REFRESH_MS = 15_000;

/** `failed` is the reader rejecting (e.g. IPC error), distinct from an `unavailable` result. */
type LoadState =
  | { kind: "loading" }
  | { kind: "not-connected" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; result: OmniHubKeepAwakeReadResult };

/**
 * Reads keep-awake snapshots while mounted: on open, every AUTO_REFRESH_MS
 * while the document is visible, on becoming visible again, and on demand.
 * `reader` defaults to the one registered by the desktop bridge integration.
 */
function useKeepAwakeSnapshot(reader: OmniHubKeepAwakeReader | null) {
  const [state, setState] = useState<LoadState>(() =>
    reader ? { kind: "loading" } : { kind: "not-connected" },
  );
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!reader || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      setState({ kind: "ready", result: await reader() });
    } catch (error) {
      setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [reader]);

  useEffect(() => {
    if (!reader) return;
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reader, refresh]);

  return { state, refreshing, refresh };
}

const relativeLabel = (ms: number) => formatRelativeTimeLabel(new Date(ms).toISOString());

/** "in 4m" / "4m ago" plus the absolute time. Missing values say so. */
function TimeValue({ ms, nowMs, missing }: { ms: number | null; nowMs: number; missing: string }) {
  if (ms === null) return <span className="text-muted-foreground">{missing}</span>;
  const iso = new Date(ms).toISOString();
  const absolute = new Date(ms).toLocaleString();
  const until = ms > nowMs ? formatRelativeTimeUntil(iso) : null;
  const relative = until
    ? until.suffix
      ? `in ${until.value}`
      : until.value.toLowerCase()
    : formatRelativeTimeLabel(iso);
  return (
    <span title={absolute}>
      {relative}
      <span className="text-muted-foreground"> · {absolute}</span>
    </span>
  );
}

/** Humanized raw OmniHub string with the exact value on hover. */
function RawValue({ value, missing }: { value: string | null; missing: string }) {
  if (!value) return <span className="text-muted-foreground">{missing}</span>;
  return <span title={value}>{formatKeepAwakeRawValue(value)}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs text-foreground">{children}</dd>
    </div>
  );
}

function CopyableId({ value, label }: { value: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: label, timeout: 1_200 });
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label={`Copy ${label}`}
        onClick={() => copyToClipboard(value)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}

const KIND_LABEL: Record<OmniHubKeepAwakeTarget["kind"], string> = {
  "t3/chatgpt_browser": "ChatGPT browser session",
  "t3/native_thread": "T3 thread",
  unknown: "Unknown session kind",
};

/**
 * Projected title (already the session UUID when T3 could not verify it), linked
 * only when the projection supplied a real URL.
 */
function TargetTitle({ target }: { target: OmniHubKeepAwakeTarget }) {
  const titled = target.title !== target.id;
  const title = titled ? target.title : "Untitled session";
  const className = titled ? undefined : "text-muted-foreground";
  if (!target.url) return <span className={className}>{title}</span>;
  const url = target.url;
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center gap-1 text-foreground underline-offset-2 hover:underline"
      title={url}
      onClick={() => void ensureLocalApi().shell.openExternal(url)}
    >
      <span className="truncate">{title}</span>
      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

const VISIBILITY_BADGE = {
  visible: null,
  hidden: { label: "Session hidden", tone: "warning" },
  missing: { label: "Session missing", tone: "error" },
  unchecked: { label: "Session unchecked", tone: "outline" },
} as const;

function MonitorRow({ monitor, nowMs }: { monitor: OmniHubKeepAwakeMonitor; nowMs: number }) {
  const status = keepAwakeStatusPresentation(monitor, nowMs);
  const visibility = VISIBILITY_BADGE[monitor.target.visibility];
  const overdue = isFinalWakeOverdue(monitor, nowMs);
  const issue = keepAwakeHasIssue(monitor, nowMs);
  const retrying = monitor.status === "retrying" || monitor.status === "final_retrying";

  return (
    <div className="space-y-2.5 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="truncate text-sm text-foreground">
            <TargetTitle target={monitor.target} />
            <span className="text-xs text-muted-foreground">
              {" "}
              · {KIND_LABEL[monitor.target.kind]}
            </span>
          </div>
          <CopyableId value={monitor.target.id} label="session ID" />
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {visibility ? <Badge variant={visibility.tone}>{visibility.label}</Badge> : null}
          {monitor.oneShot ? <Badge variant="outline">One-shot</Badge> : null}
          <Badge variant={status.tone}>{status.label}</Badge>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        <Field label="Interval">{formatKeepAwakeInterval(monitor.intervalMinutes)}</Field>
        <Field label="Ends">
          <TimeValue ms={monitor.endAtMs} nowMs={nowMs} missing="No end time" />
        </Field>
        <Field label={retrying ? "Next retry" : "Next attempt"}>
          <TimeValue ms={monitor.nextAttemptAtMs} nowMs={nowMs} missing="None scheduled" />
        </Field>
        <Field label="Last outcome">
          <RawValue value={monitor.lastOutcome} missing="No outcome yet" />
        </Field>
        <Field label="Last delivery">
          <RawValue value={monitor.lastDelivery} missing="No delivery yet" />
        </Field>
        <Field label="Wake attempts">{monitor.wakeAttempts}</Field>
        <Field label="Last wake turn">
          <TimeValue ms={monitor.lastWakeUserTurnAtMs} nowMs={nowMs} missing="None observed" />
        </Field>
        <Field label="Last agent ack">
          <TimeValue ms={monitor.lastAssistantAckAtMs} nowMs={nowMs} missing="None observed" />
        </Field>
        <Field label="Last scheduler tick">
          <TimeValue ms={monitor.lastSchedulerTickAtMs} nowMs={nowMs} missing="Never" />
        </Field>
        {monitor.finalDeliveredAtMs !== null ? (
          <Field label="Final wake delivered">
            <TimeValue ms={monitor.finalDeliveredAtMs} nowMs={nowMs} missing="" />
          </Field>
        ) : null}
        <Field label="Created">
          <TimeValue ms={monitor.createdAtMs} nowMs={nowMs} missing="Unknown" />
        </Field>
        <Field label="Mandate">
          {monitor.mandateId ? (
            <code className="font-mono" title={monitor.mandateId}>
              {monitor.mandateId}
            </code>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Field>
      </dl>

      {overdue ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          The end time has passed but the final wake has not been acknowledged; it stays active.
        </p>
      ) : null}
      {monitor.explanation ? (
        <p
          className={
            issue
              ? "flex items-start gap-1.5 text-xs text-warning-foreground"
              : "flex items-start gap-1.5 text-xs text-muted-foreground"
          }
        >
          {issue ? (
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          )}
          {monitor.explanation}
        </p>
      ) : null}
    </div>
  );
}

function MessageRow({ tone, children }: { tone: "info" | "error"; children: ReactNode }) {
  const Icon = tone === "error" ? AlertTriangleIcon : InfoIcon;
  return (
    <div className="flex items-start gap-2 px-3 py-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
      <Icon
        className={
          tone === "error"
            ? "mt-0.5 size-3.5 shrink-0 text-destructive-foreground"
            : "mt-0.5 size-3.5 shrink-0"
        }
      />
      <div>{children}</div>
    </div>
  );
}

/**
 * Settings > OmniHub Keep Awake. A read-only monitor of OmniHub's temporary
 * keep-awake wakes. It never starts, stops, or edits one.
 */
export function OmniHubKeepAwakeSettingsPanel({
  reader = getOmniHubKeepAwakeReader(),
}: {
  reader?: OmniHubKeepAwakeReader | null;
}) {
  const { state, refreshing, refresh } = useKeepAwakeSnapshot(reader);
  const nowMs = useRelativeTimeTick(30_000);

  const refreshButton = reader ? (
    <Button
      size="xs"
      variant="ghost-muted"
      onClick={() => void refresh()}
      disabled={refreshing}
      aria-label="Refresh keep-awake monitors"
    >
      <RefreshIcon refreshing={refreshing} />
      Refresh
    </Button>
  ) : null;

  const result = state.kind === "ready" ? state.result : null;
  const groups =
    result?.availability === "ok" ? groupKeepAwakeMonitors(result.monitors) : null;

  return (
    <SettingsPageContainer>
      <p className="px-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
        Temporary wakes OmniHub sends to keep agent sessions alive until an end time. These are
        not T3 scheduled tasks. This view is read-only and refreshes automatically while open.
        {result ? <> Observed {relativeLabel(result.observedAtMs)}.</> : null}
      </p>

      <SettingsSection title="Active" headerAction={refreshButton}>
        {state.kind === "not-connected" ? (
          <MessageRow tone="error">
            Keep-awake data is unavailable: this build does not connect the OmniHub keep-awake
            reader. It is only available in the desktop app once the bridge is wired up.
          </MessageRow>
        ) : state.kind === "loading" ? (
          <MessageRow tone="info">Loading keep-awake monitors…</MessageRow>
        ) : state.kind === "failed" ? (
          <MessageRow tone="error">
            Could not reach the keep-awake reader, so monitor state is unknown. ({state.message})
          </MessageRow>
        ) : result?.availability === "unavailable" ? (
          <MessageRow tone="error">
            OmniHub keep-awake data is unavailable, so monitor state is unknown. {result.error}
          </MessageRow>
        ) : groups && groups.active.length > 0 ? (
          groups.active.map((monitor) => (
            <MonitorRow key={monitor.id} monitor={monitor} nowMs={nowMs} />
          ))
        ) : (
          <MessageRow tone="info">No active keep-awake monitors.</MessageRow>
        )}
      </SettingsSection>

      {groups && groups.history.length > 0 ? (
        <SettingsSection title="History">
          {groups.history.map((monitor) => (
            <MonitorRow key={monitor.id} monitor={monitor} nowMs={nowMs} />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
