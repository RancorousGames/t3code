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
            T3 closes backend-created worker sessions after two hours without recorded activity,
            regardless of TaskBoard task status or browser availability. Their ChatGPT
            conversations remain on ChatGPT.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            Only backend-created sessions that are still workers (lavender rows) qualify.
            Opening or clicking a worker never converts it into a personal chat.
            Sending a human message, applying a personal highlight, or ever snoozing a worker
            exempts it permanently. Managers, coordinators, children with descendants,
            selected sessions and in-flight sends are preserved. Browser state and drafts are
            not inspected during automatic cleanup.
            Hide Workers does not affect cleanup.
          </p>
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            {managerAttributionAvailable
              ? `${verifiedWorkerIds.size} verified manager-linked worker(s) among ${sessions.length} sessions. Cleanup checks every 20 seconds.`
              : "Manager attribution unavailable: only explicitly eligible workers are considered."}
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
