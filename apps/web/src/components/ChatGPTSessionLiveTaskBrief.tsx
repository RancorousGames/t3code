import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

interface LiveTaskClaim {
  taskId: string;
  claimedBy: string;
  liveState: "ready" | "in_session" | null;
  taskTitle?: string;
  liveBrief?: string;
  liveEstMinutes?: number;
  liveReadyAt?: string;
}

/** TaskBoard is authoritative; this surface only reads a brief already bound to the session. */
export function ChatGPTSessionLiveTaskBrief({
  environmentId: _environmentId,
  sessionId,
  taskId,
  onPrefill,
}: {
  environmentId: EnvironmentId;
  sessionId: string;
  taskId: string | null;
  onPrefill: (text: string) => void;
}) {
  const [claim, setClaim] = useState<LiveTaskClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const read = window.desktopBridge?.readTaskBoardWorkerClaims;
    if (!read) return;
    let disposed = false;
    let running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const result = await read();
        if (disposed) return;
        // A task ID alone is insufficient if another session owns the claim.
        const bound = result.find((item) => item.taskId === taskId &&
          [sessionId.toLowerCase(), `t3-browser:${sessionId.toLowerCase()}`].includes(item.claimedBy)) ??
          result.find((item) => !taskId &&
            [sessionId.toLowerCase(), `t3-browser:${sessionId.toLowerCase()}`].includes(item.claimedBy));
        setClaim(bound?.liveState ? bound : null);
        setError(null);
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [sessionId, taskId]);

  if (!claim) return error && taskId ? (
    <p role="status" className="shrink-0 px-5 py-2 text-xs text-muted-foreground">
      TaskBoard briefing temporarily unavailable. {error}
    </p>
  ) : null;
  const age = claim.liveReadyAt ? Date.parse(claim.liveReadyAt) : NaN;
  const ageMinutes = Number.isFinite(age) ? Math.max(0, Math.floor((Date.now() - age) / 60_000)) : null;
  return (
    <section className="shrink-0 border-b border-border bg-card/50 px-5 py-3" aria-label="TaskBoard live briefing">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong className="font-semibold">{claim.liveState === "ready" ? "Prepared for you" : "With you, in progress"}</strong>
        <span className="text-muted-foreground">{claim.taskId}{claim.taskTitle ? ` · ${claim.taskTitle}` : ""}</span>
        {claim.liveEstMinutes ? <span className="text-muted-foreground">~{claim.liveEstMinutes} min</span> : null}
        {ageMinutes !== null && claim.liveState === "ready" ?
          <span className="text-muted-foreground">ready {ageMinutes < 60 ? `${ageMinutes}m` : `${Math.floor(ageMinutes / 60)}h`} ago</span> : null}
      </div>
      {claim.liveBrief ? <p className="mt-1 whitespace-pre-wrap text-sm">{claim.liveBrief}</p> :
        <p className="mt-1 text-xs text-muted-foreground">This task is marked for a live conversation. No brief was supplied.</p>}
      {claim.liveState === "ready" && (
        <div className="mt-2"><Button size="xs" variant="outline" onClick={() => onPrefill("I'm here, let's go.")}>
          Prepare “I'm here, let's go”
        </Button></div>
      )}
    </section>
  );
}
