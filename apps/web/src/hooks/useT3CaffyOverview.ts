import { useEffect, useState } from "react";
import type { ScheduledChatGPTJob } from "../components/sidebar/ChatGPTDelayedPromptDialog";

/** Read-only T3-owned scheduling state, never the obsolete OpenRig Caffy registry. */
export interface T3CaffyEntry {
  sessionId: string;
  browserSessionId?: string | undefined;
  publicSessionId?: string | undefined;
  mode: "idle" | "periodic" | "startup";
  respectSlots?: boolean;
  paused: boolean;
  onceOnly: boolean;
  expiresAt: number | null;
  intervalMinutes: number;
  beginAt?: number | null;
  autoRebootMinutes?: number | null;
  autoRebootEveryRuns?: number | null;
  repeatPrompt?: string | null;
  createdAt: number;
  rebootOperationId?: string | null;
  nextDueAt?: number | null;
  pendingWake?: boolean;
  pendingMessageId?: string | null;
  lastWakeAt?: number | null;
  lastCheckedAt?: number | null;
  lastCheckResult?: string | null;
  lastError?: string | null;
  nextCheckAt?: number | null;
  wakePhase?: string;
  availability?: string;
  transitionVersion?: number;
  deliveryStatus?: string | null;
  lastDeliveryResult?: string | null;
  deliveryAwaitingGuest?: boolean;
  admissionReason?: string | null;
  bindingObservedAt?: number | null;
}

export interface T3CaffyAgentStop {
  sessionId: string;
  browserSessionId?: string;
  publicSessionId?: string;
  stoppedAt: number;
}

export interface T3CaffyOverview {
  agentStops?: T3CaffyAgentStop[];
  maxWorking: number;
  keepT3Busy: boolean;
  shutdownWhenIdle: boolean;
  busyUntil: number | null;
  /** Why "Turn PC off when idle" hasn't fired yet, or null. */
  shutdownBlocker: string | null;
  entries: T3CaffyEntry[];
  scheduledSpawns: ScheduledChatGPTJob[];
}

export const T3_CAFFY_UPDATED_EVENT = "t3:caffy-updated";

/** Last verified scheduler snapshot, also used by non-React DOM idle eviction
 * probes. Keep the last known protection during short bridge outages.
 */
let lastVerifiedOverview: T3CaffyOverview | null = null;
export function readVerifiedT3CaffyOverview(): T3CaffyOverview | null {
  return lastVerifiedOverview;
}

/** Polling also notices schedules changed by agents, not only right-click UI. */
export function useT3CaffyOverview(): T3CaffyOverview | null {
  const [overview, setOverview] = useState<T3CaffyOverview | null>(lastVerifiedOverview);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mirrors external desktop IPC scheduler state into React across updates and reconnects.
  useEffect(() => {
    const control = window.desktopBridge?.caffyControl;
    if (!control) return;

    let mounted = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await control({ action: "list" });
        if (!mounted) return;
        if (
          !data ||
          typeof data !== "object" ||
          !("maxWorking" in data) ||
          typeof data.maxWorking !== "number" ||
          !Number.isInteger(data.maxWorking) ||
          data.maxWorking < 1 ||
          !("keepT3Busy" in data) ||
          typeof data.keepT3Busy !== "boolean" ||
          !("shutdownWhenIdle" in data) ||
          typeof data.shutdownWhenIdle !== "boolean" ||
          !("entries" in data) ||
          !Array.isArray(data.entries)
        ) {
          setOverview(lastVerifiedOverview);
          return;
        }
        const entries: T3CaffyEntry[] = data.entries.filter(
          (entry): entry is T3CaffyEntry =>
            !!entry &&
            typeof entry === "object" &&
            typeof entry.sessionId === "string" &&
            ["idle", "periodic", "startup"].includes(entry.mode) &&
            typeof entry.paused === "boolean" &&
            (entry.expiresAt === null || typeof entry.expiresAt === "number"),
        );
        const rawAgentStops = "agentStops" in data ? data.agentStops : null;
        const agentStops: T3CaffyAgentStop[] = Array.isArray(rawAgentStops)
          ? rawAgentStops.filter(
              (mark): mark is T3CaffyAgentStop =>
                !!mark &&
                typeof mark === "object" &&
                typeof mark.sessionId === "string" &&
                Number.isFinite(mark.stoppedAt),
            )
          : [];
        lastVerifiedOverview = {
          agentStops,
          maxWorking: data.maxWorking,
          keepT3Busy: data.keepT3Busy,
          shutdownWhenIdle: data.shutdownWhenIdle,
          busyUntil:
            "busyUntil" in data && typeof data.busyUntil === "number" ? data.busyUntil : null,
          shutdownBlocker:
            "shutdownBlocker" in data && typeof data.shutdownBlocker === "string"
              ? data.shutdownBlocker
              : null,
          entries,
          scheduledSpawns:
            "scheduledSpawns" in data && Array.isArray(data.scheduledSpawns)
              ? data.scheduledSpawns.filter(
                  (job): job is ScheduledChatGPTJob =>
                    !!job &&
                    typeof job === "object" &&
                    typeof job.id === "string" &&
                    typeof job.title === "string" &&
                    (job.beginAt === null ||
                      (typeof job.beginAt === "number" && Number.isSafeInteger(job.beginAt))) &&
                    ["scheduled", "dispatching", "created", "uncertain"].includes(job.status),
                )
              : [],
        };
        setOverview(lastVerifiedOverview);
      } catch {
        if (mounted) setOverview(lastVerifiedOverview);
      } finally {
        busy = false;
      }
    };
    const onUpdated = () => {
      void refresh();
    };
    void refresh();
    // Background Caffy prewarming needs fresh schedules while T3 is minimized.
    const timer = window.setInterval(() => {
      void refresh();
    }, 10_000);
    window.addEventListener(T3_CAFFY_UPDATED_EVENT, onUpdated);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      window.removeEventListener(T3_CAFFY_UPDATED_EVENT, onUpdated);
    };
  }, []);

  return overview;
}
