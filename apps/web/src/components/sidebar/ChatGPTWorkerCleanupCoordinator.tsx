import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import {
  DEFAULT_WORKER_CLEANUP_SETTINGS,
  planChatGPTWorkerCleanup,
  type WorkerCleanupSettings,
} from "../../chatGPTWorkerCleanupPolicy";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { previewUnverifiedWorkerCleanup } from "./chatGPTWorkerCleanupPreview";

const SettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  closeEnabled: Schema.Boolean,
  enabledAtMs: Schema.NullOr(Schema.Number),
  archiveGraceMs: Schema.Number,
  closeRetentionMs: Schema.Number,
});

export const chatGPTWorkerCleanupSettingsKey = (environmentId: EnvironmentId) =>
  `t3code:chatgpt-browser:worker-cleanup-settings:v1:${environmentId}`;

/**
 * Preference and preview only. No current runtime source can independently
 * attest both managed-child parent provenance and owner-issued Done receipts.
 * Never derive either from a sidebar parent link, idle tab or local completion.
 * Opened from the ChatGPT sidebar's View options menu.
 */
export function ChatGPTWorkerCleanupCoordinator({
  environmentId,
  sessions,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useLocalStorage(
    chatGPTWorkerCleanupSettingsKey(environmentId),
    DEFAULT_WORKER_CLEANUP_SETTINGS as WorkerCleanupSettings,
    SettingsSchema,
  );

  // Only inspect spawn receipts while the dialog is open. A recorded spawn is
  // evidence of a request ID, not authoritative parent provenance.
  const spawnReceipts = open ? readChatGPTSpawnReceipts(environmentId) : [];
  const preview = open ? previewUnverifiedWorkerCleanup(sessions, spawnReceipts) : [];
  const blockedPlan = open
    ? planChatGPTWorkerCleanup({
        sessions,
        links: [], // Authoritative parent-spawn attestation is not yet exposed.
        spawnReceipts,
        doneReceipts: [], // Owner-issued Done receipts are not yet exposed.
        inspections: [], // Guest-backed draft/send/recovery checks unavailable.
        ledger: [],
        settings,
        nowMs: Date.now(),
        mode: "preview",
        startupReconciled: false,
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Worker cleanup</DialogTitle>
          <DialogDescription>Preview only. Nothing is archived, hidden or closed yet.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <section aria-label="Worker auto-cleanup preferences" className="space-y-3 text-sm">
            <label className="flex items-center justify-between gap-4">
              <span>Auto-archive finished workers</span>
              <Switch
                size="sm"
                aria-label="Opt in to future automatic archive of verified completed workers"
                checked={settings.enabled}
                onCheckedChange={(enabled) =>
                  setSettings((current) => ({
                    ...current,
                    enabled,
                    enabledAtMs: enabled ? Date.now() : null,
                  }))
                }
              />
            </label>
            <label
              className={`flex items-center justify-between gap-4 ${settings.enabled ? "" : "text-muted-foreground"}`}
            >
              <span>Close 7 days after archiving</span>
              <Switch
                size="sm"
                disabled={!settings.enabled}
                aria-label="Allow future local closing of archived workers after seven days"
                checked={settings.closeEnabled && settings.enabled}
                onCheckedChange={(closeEnabled) =>
                  setSettings((current) => ({ ...current, closeEnabled }))
                }
              />
            </label>
          </section>
          <div role="status" className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              Dry run: {preview.length} parent-linked session{preview.length === 1 ? "" : "s"} to
              review; {blockedPlan?.actions.length ?? 0} authorized cleanup actions.
            </p>
            <p>
              Blocked: spawn receipts do not authenticate parent ownership; verified worker Done
              receipts and guest draft/send/recovery clearance are unavailable. Restart
              reconciliation is not connected. Existing sessions are untouched.
            </p>
          </div>
          {preview.length > 0 && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {preview.slice(0, 8).map((entry) => (
                <p key={entry.sessionId} className="break-words">
                  <span className="font-medium text-foreground">{entry.title}</span>:{" "}
                  {entry.blockReason}
                </p>
              ))}
              {preview.length > 8 && <p>{preview.length - 8} more blocked parent-linked sessions.</p>}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
