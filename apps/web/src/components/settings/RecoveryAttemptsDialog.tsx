import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import {
  readChatGPTRecoveryAttemptLog,
  subscribeChatGPTRecoveryAttemptLog,
  type ChatGPTRecoveryAttemptLogEntry,
} from "../../chatGPTRecoveryAttemptLog";
import { readChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import {
  formatChatGPTRecoveryTimeline,
  readChatGPTRecoveryTimeline,
} from "../../chatGPTRecoveryTimeline";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function RecoveryAttemptsDialog({
  open,
  onOpenChange,
  environmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
}) {
  const [entries, setEntries] = useState<ChatGPTRecoveryAttemptLogEntry[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const exportTimeline = () => {
    if (!environmentId) return;
    const text = formatChatGPTRecoveryTimeline(readChatGPTRecoveryTimeline(environmentId));
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `T3-ChatGPT-recovery-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const refresh = () => {
    if (!environmentId) {
      setEntries([]);
      setTitles({});
      return;
    }
    setEntries(readChatGPTRecoveryAttemptLog(environmentId));
    setTitles(
      Object.fromEntries(
        readChatGPTBrowserSessions(environmentId).map((session) => [session.id, session.title]),
      ),
    );
  };
  useEffect(() => {
    if (!open) return;
    const read = () => {
      if (!environmentId) {
        setEntries([]);
        setTitles({});
        return;
      }
      setEntries(readChatGPTRecoveryAttemptLog(environmentId));
      setTitles(
        Object.fromEntries(
          readChatGPTBrowserSessions(environmentId).map((session) => [session.id, session.title]),
        ),
      );
    };
    read();
    if (!environmentId) return;
    return subscribeChatGPTRecoveryAttemptLog(read);
  }, [open, environmentId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="flex max-h-[90dvh] w-[min(100%,1050px)] max-w-[1050px] flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3 pr-10">
            <DialogTitle>ChatGPT recovery attempts</DialogTitle>
            <Button size="sm" variant="outline" onClick={exportTimeline} disabled={!environmentId}>
              Export readable timeline (.txt)
            </Button>
            <Button size="sm" variant="outline" onClick={refresh}>
              <RefreshCwIcon className="size-4" /> Refresh
            </Button>
          </div>
          <DialogDescription>
            Chronological automatic recovery attempt log, newest first. Includes the ten-minute
            pause after twenty consecutive verified failures. Read-only and retained across T3
            restarts (up to 5,000 recent entries). Export readable timeline includes startup order,
            user selections, attempts, retries and verified outcomes for both native Chromium and
            legacy webviews.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="text-xs text-muted-foreground">{entries.length} recorded events</div>
          <div className="overflow-x-auto rounded-md border border-border/60">
            <table className="w-full table-fixed text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="w-[27%] px-3 py-2 font-medium">Timestamp</th>
                  <th className="w-[35%] px-3 py-2 font-medium">Session / ID</th>
                  <th className="w-[13%] px-3 py-2 font-medium">Attempt</th>
                  <th className="w-[25%] px-3 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {[...entries].reverse().map((entry, index) => (
                  <tr
                    key={entry.at + ":" + entry.kind + ":" + index}
                    className={
                      entry.kind === "backoff"
                        ? "border-t border-border/50 bg-amber-500/10"
                        : "border-t border-border/50"
                    }
                  >
                    <td className="px-3 py-2 tabular-nums align-top">
                      {new Date(entry.at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="break-words font-medium">
                        {entry.kind === "backoff"
                          ? "All ChatGPT sessions"
                          : (titles[entry.sessionId] ?? entry.sessionName)}
                      </div>
                      <div className="break-all font-mono text-xs text-muted-foreground">
                        {entry.kind === "backoff" ? "Triggered by: " : ""}
                        {entry.sessionId}
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums align-top">
                      {entry.kind === "backoff" ? "20 failures" : "#" + entry.attemptNumber}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div
                        className={entry.kind === "backoff" ? "font-semibold text-amber-500" : ""}
                      >
                        {entry.kind === "backoff" ? "10-minute pause" : entry.detail}
                      </div>
                      {entry.kind === "backoff" && entry.pauseUntil ? (
                        <div className="text-xs text-muted-foreground">
                          Resume eligible: {new Date(entry.pauseUntil).toLocaleString()}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!entries.length && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No recovery attempts or pauses have been recorded yet.
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
