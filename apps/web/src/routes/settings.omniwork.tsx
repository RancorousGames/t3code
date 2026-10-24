import { createFileRoute } from "@tanstack/react-router";

import { OmniworkSettingsPanel } from "../components/settings/OmniworkSettingsPanel";

export const Route = createFileRoute("/settings/omniwork")({
  component: OmniworkSettingsPanel,
});
