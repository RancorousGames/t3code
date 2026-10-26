import {
  AlarmClockIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  HistoryIcon,
  InfoIcon,
  MoreHorizontalIcon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import {
  controlOmniHubKeepAwakeForT3,
  readOmniHubKeepAwakeForT3,
} from "../../omniwork/omniHubKeepAwakeClient";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatRelativeTimeLabel, formatRelativeTimeUntil } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  describeKeepAwakeControlOutcome,
  formatKeepAwakeInterval,
  formatKeepAwakeRawValue,
  groupKeepAwakeMonitors,
  isFinalWakeOverdue,
  keepAwakeControlBlockedReason,
  keepAwakeHasIssue,
  keepAwakeStatusPresentation,
  type KeepAwakeControlAction,
  type OmniHubKeepAwakeController,
  type OmniHubKeepAwakeMonitor,
  type OmniHubKeepAwakeReadResult,
  type OmniHubKeepAwakeReader,
  type OmniHubKeepAwakeTarget,
} from "./omniHubKeepAwake.logic";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

// Snapshots are cheap local reads; 15s keeps "next attempt" honest without
// polling hard. Polling pauses while the window is hidden.
const AUTO_REFRESH_MS = 15_000;

/**
 * `failed` is the reader rejecting (e.g. IPC error), distinct from an `unavailable` result.
 * `not-connected` means there is no reader, or the reader resolved `null` (no desktop bridge).
 */
type LoadState =
  | { kind: "loading" }
  | { kind: "not-connected" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; result: OmniHubKeepAwakeReadResult };

const NOT_CONNECTED: LoadState = { kind: "not-connected" };

/**
 * Live reader for this T3 instance: the primary (local) environment, whose
 * persisted ChatGPT browser sessions, hidden ones included, are sent along so
 * the desktop can resolve targets. `null` until the primary environment is known.
 */
function useT3KeepAwakeReader(): OmniHubKeepAwakeReader | null {
  const environmentId = usePrimaryEnvironmentId();
  return useMemo(
    () => (environmentId ? () => readOmniHubKeepAwakeForT3(environmentId) : null),
    [environmentId],
  );
}

/** Live exact-monitor control, or `null` when this desktop build has no control bridge. */
function liveKeepAwakeController(): OmniHubKeepAwakeController | null {
  return typeof window !== "undefined" && window.desktopBridge?.controlOmniHubKeepAwakeMonitor
    ? controlOmniHubKeepAwakeForT3
    : null;
}

/**
 * Reads keep-awake snapshots while mounted: on open, every AUTO_REFRESH_MS
 * while the document is visible, on becoming visible again, and on demand.
 * A refresh requested mid-read runs once more afterwards, so a read right
 * after a control action is never dropped.
 */
function useKeepAwakeSnapshot(reader: OmniHubKeepAwakeReader | null) {
  const [state, setState] = useState<LoadState>(() =>
    reader ? { kind: "loading" } : NOT_CONNECTED,
  );
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const rerun = useRef(false);

  const refresh = useCallback(async () => {
    if (!reader) return;
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    setRefreshing(true);
    // A reader that arrives after mount (primary environment resolved) loads, not "unavailable".
    setState((current) => (current.kind === "not-connected" ? { kind: "loading" } : current));
    try {
      do {
        rerun.current = false;
        try {
          const result = await reader();
          setState(result ? { kind: "ready", result } : NOT_CONNECTED);
        } catch (error) {
          setState({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } while (rerun.current);
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

  return { state: reader ? state : NOT_CONNECTED, refreshing, refresh };
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

/** Visible result of the latest control invocation for one monitor. */
interface ControlReceiptView {
  readonly tone: "success" | "warning" | "error";
  readonly message: string;
  readonly clientRequestId: string;
}

/** Menu label with an optional muted reason line, used for disabled actions. */
function ActionLabel({ label, hint }: { label: string; hint?: string | null }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </span>
  );
}

const SEND_FINAL_UNSUPPORTED =
  "Not supported: OmniHub has no atomic final-wake-then-stop control.";

/**
 * Per-monitor "…" menu. Mutating items appear only when the desktop control
 * bridge exists (`canControl`); cancel only opens the confirmation dialog.
 */
function MonitorActions({
  monitor,
  canControl,
  pending,
  onWakeSooner,
  onRequestCancel,
}: {
  monitor: OmniHubKeepAwakeMonitor;
  canControl: boolean;
  pending: boolean;
  onWakeSooner: () => void;
  onRequestCancel: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard({ target: "monitor ID", timeout: 1_200 });
  const blocked = keepAwakeControlBlockedReason(monitor);
  const disabledHint = blocked ?? (pending ? "An action is in progress." : null);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Actions for keep-awake ${monitor.id}`}
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => copyToClipboard(monitor.id)}>
          <CopyIcon />
          Copy monitor ID
        </MenuItem>
        <MenuSeparator />
        {canControl ? (
          <>
            <MenuItem disabled={disabledHint !== null} onClick={onWakeSooner}>
              <AlarmClockIcon />
              <ActionLabel label="Wake sooner (in 1 minute)" hint={disabledHint} />
            </MenuItem>
            <MenuItem
              variant="destructive"
              disabled={disabledHint !== null}
              onClick={onRequestCancel}
            >
              <XCircleIcon />
              <ActionLabel label="Cancel keep-awake…" hint={disabledHint} />
            </MenuItem>
          </>
        ) : (
          <MenuItem disabled>
            <InfoIcon />
            <ActionLabel
              label="Controls unavailable"
              hint="This desktop build cannot control keep-awakes."
            />
          </MenuItem>
        )}
        <MenuItem disabled>
          <SendIcon />
          <ActionLabel label="Send final wake, then stop" hint={SEND_FINAL_UNSUPPORTED} />
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const RECEIPT_STYLE = {
  success: { Icon: CheckCircle2Icon, className: "text-success-foreground" },
  warning: { Icon: AlertTriangleIcon, className: "text-warning-foreground" },
  error: { Icon: AlertTriangleIcon, className: "text-destructive-foreground" },
} as const;

function ControlReceiptLine({ receipt }: { receipt: ControlReceiptView }) {
  const { Icon, className } = RECEIPT_STYLE[receipt.tone];
  return (
    <p
      className={`flex items-start gap-1.5 text-xs ${className}`}
      title={`Request ${receipt.clientRequestId}`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      {receipt.message}
    </p>
  );
}

function MonitorRow({
  monitor,
  nowMs,
  actions,
  receipt,
  pendingAction,
}: {
  monitor: OmniHubKeepAwakeMonitor;
  nowMs: number;
  actions: ReactNode;
  receipt: ControlReceiptView | undefined;
  pendingAction: KeepAwakeControlAction | undefined;
}) {
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
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex flex-wrap justify-end gap-1">
            {visibility ? <Badge variant={visibility.tone}>{visibility.label}</Badge> : null}
            {monitor.oneShot ? <Badge variant="outline">One-shot</Badge> : null}
            <Badge variant={status.tone}>{status.label}</Badge>
          </div>
          {actions}
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
      <div aria-live="polite">
        {pendingAction ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            {pendingAction === "cancel" ? "Requesting cancel…" : "Requesting wake in 1 minute…"}
          </p>
        ) : receipt ? (
          <ControlReceiptLine receipt={receipt} />
        ) : null}
      </div>
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
 * Runs exact-monitor controls: one fresh `clientRequestId` per user invocation,
 * no automatic retry, a visible receipt per monitor, and a refresh afterwards.
 * Success is shown only from the returned receipt, never optimistically.
 */
function useKeepAwakeControls(
  controller: OmniHubKeepAwakeController | null,
  refresh: () => Promise<void>,
) {
  const [pending, setPending] = useState<Record<string, KeepAwakeControlAction>>({});
  const [receipts, setReceipts] = useState<Record<string, ControlReceiptView>>({});
  const pendingRef = useRef(new Set<string>());

  const run = useCallback(
    async (monitor: OmniHubKeepAwakeMonitor, action: KeepAwakeControlAction) => {
      if (!controller || pendingRef.current.has(monitor.id)) return;
      pendingRef.current.add(monitor.id);
      const clientRequestId = randomUUID();
      setPending((current) => ({ ...current, [monitor.id]: action }));
      let outcome: Parameters<typeof describeKeepAwakeControlOutcome>[1];
      try {
        const receipt = await controller({
          monitorId: monitor.id,
          action,
          clientRequestId,
          ...(action === "cancel" ? { confirmedTargetId: monitor.target.id } : {}),
        });
        outcome = { kind: "receipt", receipt };
      } catch (error) {
        outcome = {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      pendingRef.current.delete(monitor.id);
      setReceipts((current) => ({
        ...current,
        [monitor.id]: { ...describeKeepAwakeControlOutcome(action, outcome), clientRequestId },
      }));
      setPending(({ [monitor.id]: _done, ...rest }) => rest);
      void refresh();
    },
    [controller, refresh],
  );

  return { pending, receipts, run };
}

/**
 * Settings > OmniHub Keep Awake. Monitors OmniHub's temporary keep-awake wakes
 * and, through the per-monitor menu, requests a wake in one minute or a
 * confirmed cancel. It never starts or edits one. `reader` and `controller`
 * are injectable for tests; omitted, they use this T3 instance's desktop bridge.
 */
export function OmniHubKeepAwakeSettingsPanel({
  reader: injectedReader,
  controller: injectedController,
}: {
  reader?: OmniHubKeepAwakeReader | null;
  controller?: OmniHubKeepAwakeController | null;
}) {
  const liveReader = useT3KeepAwakeReader();
  const reader = injectedReader === undefined ? liveReader : injectedReader;
  const controller =
    injectedController === undefined ? liveKeepAwakeController() : injectedController;
  const { state, refreshing, refresh } = useKeepAwakeSnapshot(reader);
  const { pending, receipts, run } = useKeepAwakeControls(controller, refresh);
  const [cancelTarget, setCancelTarget] = useState<OmniHubKeepAwakeMonitor | null>(null);
  const nowMs = useRelativeTimeTick(30_000);

  const renderRow = (monitor: OmniHubKeepAwakeMonitor) => (
    <MonitorRow
      key={monitor.id}
      monitor={monitor}
      nowMs={nowMs}
      receipt={receipts[monitor.id]}
      pendingAction={pending[monitor.id]}
      actions={
        <MonitorActions
          monitor={monitor}
          canControl={controller !== null}
          pending={pending[monitor.id] !== undefined}
          onWakeSooner={() => void run(monitor, "wake_in_one_minute")}
          onRequestCancel={() => setCancelTarget(monitor)}
        />
      }
    />
  );

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
        not T3 scheduled tasks. Use a monitor's actions menu to wake it sooner or cancel it. This
        view refreshes automatically while open.
        {result ? <> Observed {relativeLabel(result.observedAtMs)}.</> : null}
      </p>

      <SettingsSection title="Active" headerAction={refreshButton}>
        {state.kind === "not-connected" ? (
          <MessageRow tone="error">
            Keep-awake data is unavailable here, so monitor state is unknown. It can only be read
            from the T3 desktop app on the machine running OmniHub.
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
          groups.active.map(renderRow)
        ) : (
          <MessageRow tone="info">No active keep-awake monitors.</MessageRow>
        )}
      </SettingsSection>

      {groups && groups.history.length > 0 ? (
        <div className="space-y-2.5">
          {/* Strong rule so ended monitors never read as part of Active. */}
          <div className="flex items-center gap-3 px-3 sm:px-4" aria-hidden="true">
            <div className="h-0.5 flex-1 rounded-full bg-border" />
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <HistoryIcon className="size-3.5" />
              History · {groups.history.length} ended
            </span>
            <div className="h-0.5 flex-1 rounded-full bg-border" />
          </div>
          <SettingsSection title="History" hideTitle>
            {groups.history.map(renderRow)}
          </SettingsSection>
        </div>
      ) : null}

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this keep-awake?</AlertDialogTitle>
            <AlertDialogDescription>
              OmniHub stops sending future wakes to this exact session. A wake already being sent
              is not stopped, and no final wake is sent. Manager keep-awakes are protected and
              will be refused.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancelTarget ? (
            <dl className="grid gap-2 px-6 pb-6 text-xs">
              <Field label="Session">
                <TargetTitle target={cancelTarget.target} />
              </Field>
              {/* Exact IDs are shown in full, never truncated: this is what gets cancelled. */}
              <div>
                <dt className="text-muted-foreground">Monitor ID</dt>
                <dd className="break-all font-mono text-foreground">{cancelTarget.id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Target session ID</dt>
                <dd className="break-all font-mono text-foreground">{cancelTarget.target.id}</dd>
              </div>
            </dl>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep running</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const monitor = cancelTarget;
                setCancelTarget(null);
                if (monitor) void run(monitor, "cancel");
              }}
            >
              Cancel keep-awake
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
