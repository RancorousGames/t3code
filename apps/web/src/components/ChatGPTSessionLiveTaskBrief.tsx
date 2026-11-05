import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "./ui/button";
import { useChatGPTLiveTasks } from "../chatGPTLiveTasks";

/** A task brief is pinned only when this exact session owns the live task. */
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
  const claims = useChatGPTLiveTasks();
  const owners = [sessionId.toLowerCase(), `t3-browser:${sessionId.toLowerCase()}`, `t3:${sessionId.toLowerCase()}`];
  const claim = claims.find((item) => item.taskId === taskId && owners.includes(item.claimedBy)) ??
    claims.find((item) => !taskId && owners.includes(item.claimedBy));
  if (!claim?.liveState) return null;
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
