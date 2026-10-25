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

/** Displays the active cleanup policy; the cleanup runner is mounted independently. */
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
          <DialogTitle>Completed worker cleanup</DialogTitle>
          <DialogDescription>
            T3 automatically closes a finished worker’s local browser container 30 minutes after its
            assigned TaskBoard tasks reach Done. It does not delete the ChatGPT conversation.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            Direct interaction gives the worker another two hours. Managers, the coordinator,
            highlighted workers, and workers ever snoozed are permanently exempt. A worker with
            unfinished tasks or children is not closed. Unreadable sessions, drafts, UNKNOWN sends
            and currently selected sessions are preserved.
          </p>
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            {managerAttributionAvailable
              ? `${verifiedWorkerIds.size} verified worker(s) among ${sessions.length} sessions. Cleanup checks every minute.`
              : "Manager attribution unavailable: cleanup pauses rather than risk closing a manager."}
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
