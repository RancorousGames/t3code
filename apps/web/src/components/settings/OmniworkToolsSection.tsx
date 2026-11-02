import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { MessagingDiagnosticsDialog } from "./MessagingDiagnosticsDialog";
import { RecoveryAttemptsDialog } from "./RecoveryAttemptsDialog";
import { usePrimaryEnvironmentId } from "../../state/environments";

/**
 * Settings > Omniwork tool links: Diagnostics and Caffy. The
 * pages keep their own routes (`/settings/diagnostics`, `/settings/keep-awake`);
 * this section is only where they are discovered.
 */
export function OmniworkToolsSection() {
  const [messagingOpen, setMessagingOpen] = useState(false);
  const [recoveryLogOpen, setRecoveryLogOpen] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scope, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;

  return (
    <SettingsSection title="Tools">
      <SettingsRow
        {...searchableSetting("diagnostics")}
        description={
          isEnvironmentScope
            ? "Inspect processes, resource use, and logs on this environment."
            : "Inspect processes, resource use, and logs on one environment at a time."
        }
        control={
          <Button
            render={
              <Link to="/settings/diagnostics" search={{ machine: environmentId ?? undefined }} />
            }
            size="sm"
            variant="outline"
          >
            View diagnostics
          </Button>
        }
      />
      {isElectron ? (
        <SettingsRow
          {...searchableSetting("omnihub-keep-awake")}
          description="Caffy: timed wakes and managed resume-on-idle status. Ordinary when-idle messages remain in T3 Queue."
          control={
            <Button render={<Link to="/settings/keep-awake" />} size="sm" variant="outline">
              Open Caffy
            </Button>
          }
        />
      ) : null}
      {isElectron ? (
        <SettingsRow
          id="omniwork-messaging-diagnostics"
          title="Messaging diagnostics"
          description="See the live durable ChatGPT message-delivery pipeline, including queued, pending and blocked sends."
          control={
            <Button size="sm" variant="outline" onClick={() => setMessagingOpen(true)}>
              View pipeline
            </Button>
          }
        />
      ) : null}
      {isElectron ? (
        <SettingsRow
          id="omniwork-recovery-attempts-log"
          title="ChatGPT recovery attempts"
          description="Timestamped recovery attempts with session names, IDs, attempt numbers and 10-minute cooldown pauses."
          control={
            <Button size="sm" variant="outline" onClick={() => setRecoveryLogOpen(true)}>
              View recovery log
            </Button>
          }
        />
      ) : null}
      <MessagingDiagnosticsDialog open={messagingOpen} onOpenChange={setMessagingOpen} />
      <RecoveryAttemptsDialog open={recoveryLogOpen} onOpenChange={setRecoveryLogOpen}
        environmentId={primaryEnvironmentId} />
    </SettingsSection>
  );
}
