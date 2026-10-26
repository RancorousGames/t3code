import type { EnvironmentId } from "@t3tools/contracts";
import type { BrowserSession } from "../../chatGPTBrowserSessions";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Displays the policy; the cleanup runner is mounted independently of Hide Workers. */
export function ChatGPTWorkerCleanupCoordinator({
  sessions,
  verifiedWorkerIds,
  managerAttributionAvailable,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
  verifiedWorkerIds: ReadonlySet<string>;
  managerAttributionAvailable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Worker auto-cleanup</DialogTitle>
          <DialogDescription>
            T3 closes local worker sessions two hours after all assigned TaskBoard tasks reach Done,
            or after 24 hours even when tasks are unfinished. Workers with no matching tasks close
            after two hours. Their ChatGPT conversations remain on ChatGPT.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            Only backend-created sessions that are still workers (lavender rows) qualify.
            Opening or clicking a worker never converts it into a personal chat.
            Sending a human message, applying a personal highlight, or ever snoozing a worker
            exempts it permanently. Managers, coordinators, children with descendants,
            selected sessions, uninspected drafts, UNKNOWN sends and active work are preserved.
            Hide Workers does not affect cleanup.
          </p>
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            {managerAttributionAvailable
              ? `${verifiedWorkerIds.size} verified manager-linked worker(s) among ${sessions.length} sessions. Cleanup checks every minute.`
              : "Manager attribution unavailable: cleanup pauses rather than risk closing a manager."}
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
