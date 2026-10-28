import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { useChatGPTRecoverySettings } from "../../chatGPTRecoverySettings";
import { readRecoveryHistory } from "./chatGPTConversationRecovery";
import {
  readAllChatGPTRecoveryEvents,
  type ChatGPTRecoveryEvent,
} from "../../chatGPTRecoveryDiagnostics";
import {
  ChatGPTRecoveryPauseButton,
  ChatGPTRecoverySettingsControls,
} from "./ChatGPTRecoverySettingsControls";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  manuallyRetryRecovery,
  readRecoveryQueue,
  recoveryPriorityOrder,
  type RecoveryQueueEntry,
  type RecoveryQueueState,
} from "./chatGPTRecoveryQueue";

/** Display-only label for the scheduler's five verified tiers (highest first). */
const TIER_LABELS = [
  "Manual request",
  "Trusted manager",
  "Interrupted / delivery timeout",
  "Recent interaction",
  "Ordinary",
] as const;
function tierLabel(entry: RecoveryQueueEntry): string {
  if (entry.manualPriority) return TIER_LABELS[0];
  if (entry.manager) return TIER_LABELS[1];
  if (entry.interrupted) return TIER_LABELS[2];
  if (entry.recentlyClicked) return TIER_LABELS[3];
  return TIER_LABELS[4];
}

export function ChatGPTRecoveryDashboard({
  environmentId,
  open,
  onOpenChange,
  titles,
}: {
  environmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titles: Readonly<Record<string, string>>;
}) {
  const [state, setState] = useState<RecoveryQueueState>(() => readRecoveryQueue(environmentId));
  const [diagnostics, setDiagnostics] = useState<ChatGPTRecoveryEvent[]>(() =>
    readAllChatGPTRecoveryEvents(environmentId),
  );
  const [lastGlobalAttempt, setLastGlobalAttempt] = useState(
    () => readRecoveryHistory(environmentId).lastAttemptAt,
  );
  const [now, setNow] = useState(Date.now);
  const settings = useChatGPTRecoverySettings();
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      setState(readRecoveryQueue(environmentId));
      setDiagnostics(readAllChatGPTRecoveryEvents(environmentId));
      setLastGlobalAttempt(readRecoveryHistory(environmentId).lastAttemptAt);
      setNow(Date.now());
    };
    refresh();
    window.addEventListener("chatgpt-recovery-queue-updated", refresh);
    const unsubscribe = getChatGPTSessionPersistedStore(environmentId).subscribe(refresh);
    window.addEventListener("chatgpt-recovery-diagnostics-updated", refresh);
    // Data changes are subscription-driven; only relative time labels need a clock.
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      unsubscribe();
      window.removeEventListener("chatgpt-recovery-queue-updated", refresh);
      window.removeEventListener("chatgpt-recovery-diagnostics-updated", refresh);
      clearInterval(interval);
    };
  }, [environmentId, open]);
  const active = state.targets
    .map((id) => state.failures[id])
    .filter((entry): entry is RecoveryQueueEntry => !!entry);
  // Pending work in scheduler order: tier first, then oldest previous attempt.
  const queued = recoveryPriorityOrder(state)
    .filter((id) => !state.targets.includes(id))
    .map((id) => state.failures[id])
    .filter((entry): entry is RecoveryQueueEntry => !!entry);
  const attempts = state.history.filter((event) => event.kind === "attempt").length;
  const recovered = state.history.filter((event) => event.kind === "recovered").length;
  const name = (id: string) => titles[id] || id;
  const nextScan = state.lastScanAt ? state.lastScanAt + settings.scanSeconds * 1000 : null;
  const nextGlobal = lastGlobalAttempt ? lastGlobalAttempt + settings.globalSeconds * 1000 : null;
  const when = (at: number | null) =>
    at === null ? "awaiting first scan" : at <= now ? "due now" : new Date(at).toLocaleTimeString();
  const nextAction = settings.paused
    ? "Paused; resume automatic recovery to continue."
    : active.length
      ? "Next: verify the active targets, then attempt the next eligible target when global spacing permits."
      : queued.length
        ? "Next: refill vacant recovery targets on the next scan."
        : "No pending recovery actions. Monitoring continues.";

  const row = (entry: RecoveryQueueEntry) => (
    <div
      key={entry.id}
      className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={entry.id}>
          {name(entry.id)}
        </div>
        <div className="text-xs text-muted-foreground">
          {tierLabel(entry)} · {entry.reason} · {entry.attempts}{" "}
          {entry.attempts === 1 ? "attempt" : "attempts"}
          {entry.lastAttemptAt
            ? " · last " + new Date(entry.lastAttemptAt).toLocaleTimeString()
            : " · not yet attempted"}
        </div>
        <div className="text-xs text-muted-foreground">{entry.lastOutcome}</div>
      </div>
      {!state.targets.includes(entry.id) && !entry.manualPriority && (
        <Button
          size="xs"
          variant="outline"
          title="Move to the manual-request tier; global spacing still applies"
          onClick={() => {
            manuallyRetryRecovery(environmentId, entry.id);
            setState(readRecoveryQueue(environmentId));
          }}
        >
          Retry
        </Button>
      )}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ChatGPT recovery dashboard</DialogTitle>
          <DialogDescription>
            Session recovery log, scheduling, targets and results. Diagnostic counters reset on T3
            restart, not panel remount.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3">
              <div>
                <div className="font-semibold">
                  Auto recovery: {settings.paused ? "Paused" : "Running"}
                </div>
                <div className="text-xs text-muted-foreground">{nextAction}</div>
              </div>
              <ChatGPTRecoveryPauseButton />
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded border px-2 py-1">
                Targets {active.length}/{settings.targetCount}
              </span>
              <span className="rounded border px-2 py-1">Queued {queued.length}</span>
              <span className="rounded border px-2 py-1">Attempts {attempts}</span>
              <span className="rounded border px-2 py-1">Verified recoveries {recovered}</span>
              <span className="rounded border px-2 py-1">Scan every {settings.scanSeconds}s</span>
              <span className="rounded border px-2 py-1">
                Global retry every {settings.globalSeconds}s
              </span>
            </div>
            <section className="rounded-md border border-border/60 p-3">
              <h3 className="mb-1 font-semibold">Recovery schedule and next steps</h3>
              <div className="text-xs text-muted-foreground">
                Last scan:{" "}
                {state.lastScanAt ? new Date(state.lastScanAt).toLocaleTimeString() : "not yet"}
              </div>
              <div className="text-xs text-muted-foreground">
                Next scan: {settings.paused ? "paused" : when(nextScan)}
              </div>
              <div className="text-xs text-muted-foreground">
                Next global retry eligible: {settings.paused ? "paused" : when(nextGlobal)}
              </div>
              <div className="text-xs text-muted-foreground">
                Queue order: {TIER_LABELS.join(" > ")}; oldest previous attempt first within a tier.
                Retries continue until verified recovery.
              </div>
            </section>
            <details className="rounded-md border border-border/60 p-3">
              <summary className="cursor-pointer font-semibold">
                Recovery settings (also in Settings → Omniwork)
              </summary>
              <div className="mt-3">
                <ChatGPTRecoverySettingsControls />
              </div>
            </details>
            <section>
              <h3 className="mb-2 font-semibold">Active targets</h3>
              <div className="flex flex-col gap-1">
                {active.length ? (
                  active.map(row)
                ) : (
                  <p className="text-xs text-muted-foreground">No active errors.</p>
                )}
              </div>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">Queued work</h3>
              <div className="flex flex-col gap-1">
                {queued.length ? (
                  queued.map(row)
                ) : (
                  <p className="text-xs text-muted-foreground">Queue empty.</p>
                )}
              </div>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">
                Chronological attempt/queue history (newest first)
              </h3>
              <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-xs">
                {[...state.history].reverse().map((event, index) => (
                  <div
                    key={event.at + ":" + index}
                    className="rounded border border-border/50 px-2 py-1.5"
                  >
                    <div className="break-words">
                      <span className="text-muted-foreground">
                        {new Date(event.at).toLocaleTimeString()}{" "}
                      </span>
                      <strong>{event.kind}</strong> · {name(event.id)} · {event.detail}
                    </div>
                    <div className="text-muted-foreground">
                      Targets: {event.targets.map(name).join(", ") || "none"} | Queued:{" "}
                      {event.queued.map(name).join(", ") || "none"}
                    </div>
                  </div>
                ))}
                {!state.history.length && <p className="text-muted-foreground">No attempts yet.</p>}
              </div>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">
                Diagnostic recovery log ({diagnostics.length} latest events)
              </h3>
              <div className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                {[...diagnostics].reverse().map((event, index) => (
                  <div
                    key={event.at + ":" + index}
                    className="rounded border border-border/50 px-2 py-1"
                  >
                    <span className="text-muted-foreground">
                      {new Date(event.at).toLocaleTimeString()}{" "}
                    </span>
                    <strong>{event.event}</strong> · {name(event.sessionId)} · {event.detail || ""}
                  </div>
                ))}
                {!diagnostics.length && (
                  <p className="text-muted-foreground">No diagnostic events yet.</p>
                )}
              </div>
            </section>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
