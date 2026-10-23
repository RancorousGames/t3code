import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import {
  DEFAULT_WORKER_CLEANUP_SETTINGS,
  planChatGPTWorkerCleanup,
  type WorkerCleanupSettings,
} from "../../chatGPTWorkerCleanupPolicy";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";
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
 */
export function ChatGPTWorkerCleanupCoordinator({
  environmentId,
  sessions,
}: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useLocalStorage(
    chatGPTWorkerCleanupSettingsKey(environmentId),
    DEFAULT_WORKER_CLEANUP_SETTINGS as WorkerCleanupSettings,
    SettingsSchema,
  );

  // Only inspect spawn receipts when the user opens the preview. A recorded
  // spawn is evidence of a request ID, not authoritative parent provenance.
  const spawnReceipts = expanded ? readChatGPTSpawnReceipts(environmentId) : [];
  const preview = previewUnverifiedWorkerCleanup(sessions, spawnReceipts);
  const blockedPlan = expanded
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
    <>
      <SidebarMenuItem>
        <Button
          size="sm"
          variant="ghost-muted"
          aria-label="Worker auto-cleanup settings and dry-run preview"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ArchiveIcon aria-hidden className="size-3.5" />
          <span>Worker cleanup (preview only)</span>
          {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        </Button>
      </SidebarMenuItem>
      {expanded && (
        <SidebarMenuItem>
          <section
            aria-label="Worker auto-cleanup preferences"
            className="space-y-2 px-2 pb-2 text-xs"
          >
            <p className="text-muted-foreground">
              No automatic hiding, archiving, or closing is running. These preferences are saved for
              a future verified completion-owner integration.
            </p>
            <Button
              size="sm"
              variant="outline"
              aria-label="Opt in to future automatic archive of verified completed workers"
              aria-pressed={settings.enabled}
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  enabled: !current.enabled,
                  enabledAtMs: current.enabled ? null : Date.now(),
                }))
              }
            >
              Auto-archive preference: {settings.enabled ? "On" : "Off"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!settings.enabled}
              aria-label="Allow future local closing of archived workers after seven days"
              aria-pressed={settings.closeEnabled && settings.enabled}
              onClick={() =>
                setSettings((current) => ({ ...current, closeEnabled: !current.closeEnabled }))
              }
            >
              Close after 7 days: {settings.closeEnabled && settings.enabled ? "On" : "Off"}
            </Button>
            <div role="status" className="space-y-1 text-muted-foreground">
              <p>
                Dry run: {preview.length} parent-linked session{preview.length === 1 ? "" : "s"} to
                review; {blockedPlan?.actions.length ?? 0} authorized cleanup actions.
              </p>
              <p>
                Blocked: spawn receipts do not authenticate parent ownership; verified worker Done
                receipts and guest draft/send/recovery clearance are unavailable. Restart
                reconciliation is not connected. Existing sessions are untouched.
              </p>
            </div>
            {preview.slice(0, 8).map((entry) => (
              <p key={entry.sessionId} className="break-words text-muted-foreground">
                <span className="font-medium text-foreground">{entry.title}</span>:{" "}
                {entry.blockReason}
              </p>
            ))}
            {preview.length > 8 && (
              <p className="text-muted-foreground">
                {preview.length - 8} more blocked parent-linked sessions.
              </p>
            )}
          </section>
        </SidebarMenuItem>
      )}
    </>
  );
}
