import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

interface Monitor {
  sessionId: string;
  mode: "idle" | "periodic" | "queued";
  paused: boolean;
  startup: boolean;
  onceOnly: boolean;
  intervalMinutes: number;
  expiresAt: number | null;
  pendingMessageId: string | null;
  lastError: string | null;
}
interface Config {
  entries: Monitor[];
  keepT3Busy: boolean;
  maxWorking: number;
}
interface Capacity {
  working: number;
  reserved: number;
  limit: number;
  available: number;
  admissible: boolean;
  reason: string | null;
}

/** T3 is the only scheduler for all newly created Caffy monitors. */
export function CaffyV2Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [limit, setLimit] = useState("6");
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const refresh = useCallback(async () => {
    const api = window.desktopBridge?.caffyControl;
    if (!api) {
      setError("Caffy v2 requires a current T3 desktop build.");
      return;
    }
    try {
      const result = await api({ action: "list" });
      if (!result || typeof result !== "object" ||
          !("entries" in result) || !Array.isArray(result.entries) ||
          !("keepT3Busy" in result) || typeof result.keepT3Busy !== "boolean" ||
          !("maxWorking" in result) || typeof result.maxWorking !== "number")
        throw new Error("T3 Caffy returned an incomplete configuration.");
      const updated = result as Config;
      setConfig(updated);
      if (document.activeElement?.id !== "t3-caffy-limit")
        setLimit(String(updated.maxWorking));
      const occupancy = await api({ action: "capacity" });
      if (occupancy && typeof occupancy === "object" &&
          "working" in occupancy && typeof occupancy.working === "number" &&
          "limit" in occupancy && typeof occupancy.limit === "number")
        setCapacity(occupancy as Capacity);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const setPolicy = async (input: { keepT3Busy?: boolean; maxWorking?: number }) => {
    const api = window.desktopBridge?.caffyControl;
    if (!api || updating) return;
    setUpdating(true);
    try {
      await api({ action: "policy", ...input });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setUpdating(false); }
  };
  return (
    <SettingsSection title="T3-owned Caffy & queued work" headerAction={
      <Button size="xs" variant="ghost-muted" onClick={() => void refresh()}>Refresh</Button>
    }>
      <div className="space-y-3 px-3 py-3 text-xs sm:px-4">
        <p className="text-muted-foreground">
          New Caffy monitors and TaskBoard queued tasks run through T3.
          The capacity applies only to automatic queued work, not manually opened sessions.
        </p>
        {config ? (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={config.keepT3Busy} disabled={updating}
                onChange={event => void setPolicy({keepT3Busy: event.currentTarget.checked})} />
              <span>Keep T3 Busy — permit automatic TaskBoard jobs and queued Caffy wakes</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="t3-caffy-limit">Maximum working agents</label>
              <input id="t3-caffy-limit" type="number" min="1" max="100" step="1"
                className="w-16 rounded border bg-background px-2 py-1"
                value={limit} onChange={event => setLimit(event.target.value)} />
              <Button size="xs" variant="outline" disabled={updating ||
                !Number.isInteger(Number(limit)) || Number(limit) < 1 ||
                Number(limit) > 100 || Number(limit) === config.maxWorking}
                onClick={() => void setPolicy({maxWorking: Number(limit)})}>Save</Button>
            </div>
            {capacity && <p className="text-muted-foreground">
              Working: {capacity.working} · Reserved: {capacity.reserved} ·
              Limit: {capacity.limit} · Available: {capacity.available}
              {capacity.reason ? ` · ${capacity.reason}` : ""}
            </p>}
            <p className="font-medium">{config.entries.length} active monitor(s)</p>
            {config.entries.map(entry => (
              <div className="space-y-1 rounded border px-2 py-2" key={entry.sessionId}>
                <div className="font-mono">{entry.sessionId}</div>
                <div>
                  {entry.mode}{entry.paused ? " · Paused" : ""}
                  {entry.startup ? " · Startup resume" : ""}
                  {entry.onceOnly ? " · Once" : ""}
                  {entry.mode === "periodic" ? ` · Every ${entry.intervalMinutes}m` : ""}
                  {entry.expiresAt === null ? " · Infinite" : ` · Ends ${new Date(entry.expiresAt).toLocaleString()}`}
                  {entry.pendingMessageId ? " · Wake queued" : ""}
                </div>
                {entry.lastError && <div className="text-destructive">{entry.lastError}</div>}
              </div>
            ))}
          </>
        ) : <p className="text-muted-foreground">T3 Caffy status unavailable.</p>}
        {error && <p className="text-destructive" role="status">{error}</p>}
      </div>
    </SettingsSection>
  );
}
