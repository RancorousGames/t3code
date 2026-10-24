// Visual composition supplied by Claude Sonnet for T3-0036.
import { useMemo } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useOmniworkPreferences } from "../../omniwork/chatGPTUnloadPolicy";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const UNLOAD_PROFILES = [
  {
    value: "never",
    label: "Never",
    description: "Keep every ChatGPT session loaded. Highest memory use.",
  },
  {
    value: "conservative",
    label: "Conservative",
    description: "Unload only sessions that have been idle for a long time.",
  },
  {
    value: "balanced",
    label: "Balanced (default)",
    description: "Unload idle sessions after a moderate delay.",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    description: "Unload idle sessions quickly to save the most memory.",
  },
] as const;

const SAFE_STATES = ["pinned", "manager", "working", "draft", "unknown"] as const;

function isDesktop(): boolean {
  return typeof window !== "undefined" && "desktopBridge" in window;
}

export function OmniworkSettingsPanel() {
  const { unloadProfile, setUnloadProfile } = useOmniworkPreferences();
  const desktop = isDesktop();

  const selected = useMemo(
    () => UNLOAD_PROFILES.find((profile) => profile.value === unloadProfile),
    [unloadProfile],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Omniwork">
        <SettingsRow
          id="omniwork-chatgpt-unloading"
          title="ChatGPT session unloading"
          description={
            selected?.description ??
            "Choose how eagerly idle ChatGPT sessions are unloaded to free memory."
          }
          control={
            <Select
              value={unloadProfile}
              onValueChange={(value) => {
                if (value && UNLOAD_PROFILES.some((profile) => profile.value === value)) {
                  setUnloadProfile(value as (typeof UNLOAD_PROFILES)[number]["value"]);
                }
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="ChatGPT session unloading">
                <SelectValue>{selected?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {UNLOAD_PROFILES.map((profile) => (
                  <SelectItem key={profile.value} value={profile.value}>
                    {profile.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Always kept loaded"
          description={`Sessions that are ${SAFE_STATES.join(", ")} are never unloaded, whatever profile you choose. Only sessions confirmed idle are eligible.`}
        />
        <SettingsRow
          title="Availability"
          description={
            desktop
              ? "Session unloading is active in the desktop app."
              : "Session unloading is a device-local desktop feature. Open T3 Code desktop to change it."
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
