import { createFileRoute } from "@tanstack/react-router";

import { OmniHubKeepAwakeSettingsPanel } from "../components/settings/OmniHubKeepAwakeSettings";

function SettingsKeepAwakeRoute() {
  return <OmniHubKeepAwakeSettingsPanel />;
}

export const Route = createFileRoute("/settings/keep-awake")({
  component: SettingsKeepAwakeRoute,
});
