import { Link } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings > Omniwork tool links: Diagnostics and OmniHub Keep Awake. The
 * pages keep their own routes (`/settings/diagnostics`, `/settings/keep-awake`);
 * this section is only where they are discovered.
 */
export function OmniworkToolsSection() {
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
          description="View and manage OmniHub's temporary keep-awake wakes for agent sessions. Not T3 scheduled tasks."
          control={
            <Button render={<Link to="/settings/keep-awake" />} size="sm" variant="outline">
              View monitors
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
