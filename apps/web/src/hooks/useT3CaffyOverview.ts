import { useEffect, useState } from "react";

/** Read-only T3-owned scheduling state, never the obsolete OpenRig Caffy registry. */
export interface T3CaffyEntry {
  sessionId: string;
  browserSessionId?: string | undefined;
  publicSessionId?: string | undefined;
  mode: "idle" | "periodic" | "queued" | "startup";
  paused: boolean;
  onceOnly: boolean;
  expiresAt: number | null;
  intervalMinutes: number;
}

export interface T3CaffyOverview {
  maxWorking: number;
  keepT3Busy: boolean;
  entries: T3CaffyEntry[];
}

export const T3_CAFFY_UPDATED_EVENT = "t3:caffy-updated";

/** Polling also notices schedules changed by agents, not only right-click UI. */
export function useT3CaffyOverview(): T3CaffyOverview | null {
  const [overview, setOverview] = useState<T3CaffyOverview | null>(null);

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
        if (!data || typeof data !== "object" ||
            !("maxWorking" in data) || typeof data.maxWorking !== "number" ||
            !Number.isInteger(data.maxWorking) || data.maxWorking < 1 ||
            !("keepT3Busy" in data) || typeof data.keepT3Busy !== "boolean" ||
            !("entries" in data) || !Array.isArray(data.entries)) {
          setOverview(null);
          return;
        }
        const entries: T3CaffyEntry[] = data.entries.filter((entry): entry is T3CaffyEntry =>
          !!entry && typeof entry === "object" &&
          typeof entry.sessionId === "string" &&
          ["idle", "periodic", "queued", "startup"].includes(entry.mode) &&
          typeof entry.paused === "boolean" &&
          (entry.expiresAt === null || typeof entry.expiresAt === "number"),
        );
        setOverview({
          maxWorking: data.maxWorking,
          keepT3Busy: data.keepT3Busy,
          entries,
        });
      } catch {
        if (mounted) setOverview(null);
      } finally {
        busy = false;
      }
    };
    const onUpdated = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
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
