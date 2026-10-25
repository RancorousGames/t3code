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
  const [settings, setSettings] = useLocalStorage(
    chatGPTWorkerCleanupSettingsKey(environmentId),
    DEFAULT_WORKER_CLEANUP_SETTINGS as WorkerCleanupSettings,
    SettingsSchema,
  );

  // Only inspect spawn receipts while the dialog is open. A recorded spawn is
  // evidence of a request ID, not authoritative parent provenance.
  const spawnReceipts = open ? readChatGPTSpawnReceipts(environmentId) : [];
  const preview = open
    ? previewUnverifiedWorkerCleanup(sessions, spawnReceipts, verifiedWorkerIds)
    : [];
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
          <DialogTitle>Worker cleanup preferences</DialogTitle>
          <DialogDescription>
            No automatic cleanup runs yet. These switches save preferences for a future cleanup
            feature; they do not archive, hide or close any sessions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <section aria-label="Worker auto-cleanup preferences" className="space-y-3 text-sm">
            <label className="flex items-center justify-between gap-4">
              <span>Future: Auto-archive finished workers</span>
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
              <span>Future: Close 7 days after archiving</span>
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
              {managerAttributionAvailable
                ? `Informational list: ${preview.length} identified worker${preview.length === 1 ? "" : "s"}; none are cleanup candidates.`
                : preview.length > 0
                  ? `Live manager verification unavailable: showing ${preview.length} previously verified worker${preview.length === 1 ? "" : "s"} only. None are cleanup candidates.`
                  : "Worker identification unavailable: no current or cached manager seat evidence."}
            </p>
            <p>
              This is NOT a list of sessions that would be cleaned if you enabled the switches.
              Cleanup requires separately verified ownership, Done receipts and safe guest-state
              checks, which are not connected. {blockedPlan?.actions.length ?? 0} actions available.
            </p>
            <p>
              Show workers affects sidebar rows only, independently of these preferences. All
              sessions, active work and unsent drafts remain untouched.
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
              {preview.length > 8 && <p>{preview.length - 8} more informational worker rows.</p>}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
