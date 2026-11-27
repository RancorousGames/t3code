import {
  T3_AGENT_PROVIDER_VERSION,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { randomUUID } from "../lib/utils";
import { agentProviderCall } from "../state/agentProvider";
import { useAtomCommand } from "../state/use-atom-command";
import { useStableCallback } from "./useStableCallback";
import { T3_CAFFY_UPDATED_EVENT, type T3CaffyEntry } from "./useT3CaffyOverview";

export type NativeCaffyMonitor = Omit<T3CaffyEntry, "createdAt" | "expiresAt"> &
  Partial<Pick<T3CaffyEntry, "createdAt" | "expiresAt">> & { compact?: boolean };

type ControlInput = { action: string; [key: string]: unknown };
type RemoteSession = {
  kind: string;
  source: { rawThreadId?: string };
  visibility?: {
    caffyMode?: "idle" | "periodic" | "startup";
    caffyPaused?: boolean;
    caffyOnceOnly?: boolean;
    caffyIntervalMinutes?: number;
    caffyBeginAt?: number | null;
  };
};

/** The desktop owns Caffy. Browser clients use the existing authenticated
 * remote native-thread protocol; no second scheduler or local timers. */
export function useNativeCaffy(environmentIds: readonly EnvironmentId[]) {
  const call = useAtomCommand(agentProviderCall, { reportFailure: false, reportDefect: false });
  const rpc = useStableCallback(
    async (environmentId: EnvironmentId, method: string, params: unknown) => {
      const result = await call({
        environmentId,
        input: { apiVersion: T3_AGENT_PROVIDER_VERSION, requestId: randomUUID(), method, params },
      });
      if (result._tag !== "Success") throw new Error("Caffy connection unavailable.");
      if (!result.value.ok) throw new Error(result.value.error.message);
      return result.value.data;
    },
  );

  const control = useStableCallback(async (thread: ScopedThreadRef, input: ControlInput) => {
    const local = window.desktopBridge?.caffyControl;
    if (local) return local(input as Parameters<typeof local>[0]);
    const session = { provider: "t3", id: `thread:${encodeURIComponent(thread.threadId)}` };
    const base = { expectedEnvironmentId: thread.environmentId, session };
    if (input.action === "status") {
      const result = (await rpc(thread.environmentId, "sessions.controls", base)) as {
        caffyAvailable?: boolean;
        caffy?: unknown;
      };
      if (!result?.caffyAvailable)
        throw new Error("The host desktop Caffy scheduler is unavailable.");
      return result.caffy ?? null;
    }
    const {
      action,
      sessionId: _session,
      targetKind: _kind,
      environmentId: _env,
      stopInitiator: _initiator,
      lifecycleReason: _reason,
      keepAwake: _keepAwake,
      ...options
    } = input;
    if (!["set", "stop", "pause", "resume", "startup", "wake", "retire"].includes(action))
      throw new Error("Unsupported native Caffy action.");
    const remoteOptions = action === "startup" ? { value: options.startup } : options;
    return rpc(thread.environmentId, "sessions.control", {
      ...base,
      command: `caffy_${action}`,
      options: remoteOptions,
    });
  });

  const [monitors, setMonitors] = useState<Map<string, NativeCaffyMonitor>>(new Map());
  // Stable dependency across unrelated sidebar updates.
  const environmentKey = JSON.stringify([...environmentIds].sort());
  useEffect(() => {
    if (window.desktopBridge?.caffyControl) return;
    const ids = JSON.parse(environmentKey) as EnvironmentId[];
    let disposed = false;
    let pending = false;
    let again = false;
    const refresh = async () => {
      if (disposed || document.hidden) return;
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      try {
        const results = await Promise.all(
          ids
            .map(async (environmentId) => {
              const list = (await rpc(environmentId, "sessions.list", {})) as {
                items?: RemoteSession[];
              };
              const entries: NativeCaffyMonitor[] = [];
              for (const row of list.items ?? []) {
                const v = row.visibility;
                const id = row.source?.rawThreadId;
                if (
                  row.kind !== "t3/thread" ||
                  !id ||
                  !v?.caffyMode ||
                  !["idle", "periodic", "startup"].includes(v.caffyMode) ||
                  typeof v.caffyPaused !== "boolean" ||
                  typeof v.caffyOnceOnly !== "boolean" ||
                  typeof v.caffyIntervalMinutes !== "number"
                )
                  continue;
                entries.push({
                  sessionId: `t3:${environmentId}:${id}`,
                  mode: v.caffyMode,
                  paused: v.caffyPaused,
                  onceOnly: v.caffyOnceOnly,
                  intervalMinutes: v.caffyIntervalMinutes,
                  ...(v.caffyBeginAt !== undefined ? { beginAt: v.caffyBeginAt } : {}),
                  compact: true,
                });
              }
              return entries;
            })
            .map((promise) => promise.catch(() => [])),
        );
        if (!disposed)
          setMonitors(new Map(results.flat().map((entry) => [entry.sessionId, entry])));
      } finally {
        pending = false;
        if (again) {
          again = false;
          void refresh();
        }
      }
    };
    const update = () => {
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(update, 10_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener(T3_CAFFY_UPDATED_EVENT, update);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener(T3_CAFFY_UPDATED_EVENT, update);
    };
  }, [environmentKey, rpc]);
  return { control, monitors };
}
