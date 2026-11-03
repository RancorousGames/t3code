// Visual composition supplied by Claude Sonnet for T3-0036.
import { useMemo, useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  CHATGPT_WARM_SESSION_COUNTS,
  useOmniworkPreferences,
} from "../../omniwork/chatGPTUnloadPolicy";
import {
  updateChatGPTRecoverySettings,
  useChatGPTRecoverySettings,
} from "../../chatGPTRecoverySettings";
import type { ChatGPTOrangeRecoveryStrategy } from "../../chatGPTOrangeRecoveryStrategy";
import {
  CHATGPT_BROWSER_ENGINE_KEY,
  configuredChatGPTBrowserEngine,
  type ChatGPTBrowserEngine,
} from "../../browser/persistentChatGPTSessionMode";
import { OmniworkToolsSection } from "./OmniworkToolsSection";
import { ChatGPTRecoverySettingsControls } from "../sidebar/ChatGPTRecoverySettingsControls";
import { useChatGPTDefaultView } from "../../chatGPTSessionViewPreferences";
import { useChatGPTRestartContinuationEnabled } from "../../omniwork/chatGPTRestartContinuationSetting";
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

const ORANGE_RECOVERY_STRATEGIES = [
  {
    value: "reload-stop-continue",
    label: "Reload → Stop → Continue (default)",
    description:
      "After the orange grace period, reload; if still stalled, Stop and send one guarded Continue.",
  },
  {
    value: "reload-only",
    label: "Reload only",
    description: "Try one conversation reload. Never click Stop or send a Continue automatically.",
  },
  {
    value: "reload-stop",
    label: "Reload → Stop",
    description: "Reload and, if still stalled, click Stop. Leave resuming the response to you.",
  },
  {
    value: "observe-only",
    label: "Observe only",
    description:
      "Monitor orange stalls without reloading, stopping, or sending anything automatically.",
  },
] as const;

function isDesktop(): boolean {
  return typeof window !== "undefined" && "desktopBridge" in window;
}

export function OmniworkSettingsPanel() {
  const {
    unloadProfile,
    setUnloadProfile,
    recentGuests,
    setRecentGuests,
    loadAllChatGPTSessionsOnStartup,
    setLoadAllChatGPTSessionsOnStartup,
    chatGPTWarmSessionCount,
    setChatGPTWarmSessionCount,
    chatGPTMaxAutoSessionCount,
    setChatGPTMaxAutoSessionCount,
    liveTaskStartKind,
    setLiveTaskStartKind,
    showWorkersWithSelectedParent,
    setShowWorkersWithSelectedParent,
    erroredSessionsAtBottom,
    setErroredSessionsAtBottom,
  } = useOmniworkPreferences();
  const desktop = isDesktop();
  const [browserEngine, setBrowserEngine] = useState<ChatGPTBrowserEngine>(
    configuredChatGPTBrowserEngine,
  );
  const [defaultChatGPTView, setDefaultChatGPTView] = useChatGPTDefaultView();
  const [resumeManagedAfterRestart, setResumeManagedAfterRestart] =
    useChatGPTRestartContinuationEnabled();
  const recoverySettings = useChatGPTRecoverySettings();
  const orangeRecoverySelection = ORANGE_RECOVERY_STRATEGIES.find(
    ({ value }) => value === recoverySettings.orangeStrategy,
  );

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
          id="omniwork-chatgpt-retained-count"
          title="Recent sessions exempt from unloading"
          description="Protect this many recently used ordinary sessions from automatic unloading. Does not load sessions that are already unloaded. Important sessions remain protected separately."
          control={
            <Select
              value={recentGuests === null ? "default" : String(recentGuests)}
              onValueChange={(value) => {
                if (value) setRecentGuests(value === "default" ? null : Number(value));
              }}
              disabled={!desktop || unloadProfile === "never"}
            >
              <SelectTrigger size="sm" aria-label="Recent sessions exempt from unloading">
                <SelectValue>
                  {recentGuests === null ? "Profile default" : recentGuests}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="default">Profile default</SelectItem>
                {[0, 3, 5, 8, 12, 16, 24, 32].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count}
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
      <SettingsSection title="ChatGPT recovery">
        <SettingsRow
          id="omniwork-chatgpt-orange-recovery-strategy"
          title="Recovering (orange) session handling"
          description={`${orangeRecoverySelection?.description ?? "Choose what automatic recovery may do."} Red load failures and draft/UNKNOWN-send safety remain unchanged.`}
          control={
            <Select
              value={recoverySettings.orangeStrategy}
              onValueChange={(value) => {
                if (ORANGE_RECOVERY_STRATEGIES.some((strategy) => strategy.value === value))
                  updateChatGPTRecoverySettings({
                    orangeStrategy: value as ChatGPTOrangeRecoveryStrategy,
                  });
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="Recovering session handling strategy">
                <SelectValue>{orangeRecoverySelection?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {ORANGE_RECOVERY_STRATEGIES.map((strategy) => (
                  <SelectItem key={strategy.value} value={strategy.value}>
                    {strategy.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <div
          className="rounded-md border border-border/50 px-4 py-3"
          aria-label="ChatGPT automatic recovery timing and cooldown settings"
        >
          <ChatGPTRecoverySettingsControls />
        </div>
      </SettingsSection>
      <SettingsSection title="ChatGPT browser engine">
        <SettingsRow
          id="omniwork-chatgpt-browser-engine"
          title="ChatGPT browser engine"
          description="Native Chromium preserves browser pages during safe UI rebuilds. Original Webviews restores the previous Electron webview integration. Changing engines requires a hard T3 restart and reloads ChatGPT pages."
          control={
            <Select
              value={browserEngine}
              disabled={!desktop}
              onValueChange={(value) => {
                if (value !== "native" && value !== "webview") return;
                localStorage.setItem(CHATGPT_BROWSER_ENGINE_KEY, value);
                setBrowserEngine(value);
              }}
            >
              <SelectTrigger size="sm" aria-label="ChatGPT browser engine">
                <SelectValue>
                  {browserEngine === "native" ? "Native Chromium (default)" : "Original Webviews"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="native">Native Chromium (default)</SelectItem>
                <SelectItem value="webview">Original Webviews</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title="ChatGPT session view">
        <SettingsRow
          id="omniwork-chatgpt-default-view"
          title="Default ChatGPT view"
          description="Session shows the status, last observed exchange and guarded composer. Browser shows the original ChatGPT page. Each session can override this without reloading its guest."
          control={
            <Select
              value={defaultChatGPTView}
              disabled={!desktop}
              onValueChange={(value) => {
                if (value === "session" || value === "browser") setDefaultChatGPTView(value);
              }}
            >
              <SelectTrigger size="sm" aria-label="Default ChatGPT view">
                <SelectValue>
                  {defaultChatGPTView === "session" ? "Session (default)" : "Browser"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="session">Session (default)</SelectItem>
                <SelectItem value="browser">Browser</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="omniwork-chatgpt-restart-continuation"
          title="Resume interrupted managed ChatGPT work after restart"
          description="On (default): if a manager or worker was independently observed generating when T3 stopped, remount its exact conversation and send one guarded Continue only if the reply did not advance. Never applies to personal chats, drafts, UNKNOWN sends or after direct interaction. Applies next T3 restart."
          control={
            <Select
              value={resumeManagedAfterRestart ? "on" : "off"}
              disabled={!desktop}
              onValueChange={(value) => {
                if (value === "on" || value === "off") setResumeManagedAfterRestart(value === "on");
              }}
            >
              <SelectTrigger size="sm" aria-label="Resume managed ChatGPT work after restart">
                <SelectValue>{resumeManagedAfterRestart ? "On (default)" : "Off"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="on">On (default)</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title="ChatGPT worker visibility">
        <SettingsRow
          id="omniwork-selected-parent-workers"
          title="Show workers when their parent is selected"
          description="When Hide workers is active, temporarily reveal direct worker children of the selected session. Other workers remain hidden."
          control={
            <Select
              value={showWorkersWithSelectedParent ? "on" : "off"}
              onValueChange={(value) => {
                if (value === "on" || value === "off")
                  setShowWorkersWithSelectedParent(value === "on");
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="Show workers of selected parent">
                <SelectValue>{showWorkersWithSelectedParent ? "On" : "Off (default)"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="off">Off (default)</SelectItem>
                <SelectItem value="on">On</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title="ChatGPT startup loading">
        <SettingsRow
          id="omniwork-chatgpt-startup-loading"
          title="Load all existing ChatGPT sessions on startup"
          description="Off (default): restored sessions wait until selected or chosen for gradual warming. Newly created sessions still load normally. Applies next T3 restart."
          control={
            <Select
              value={loadAllChatGPTSessionsOnStartup ? "on" : "off"}
              onValueChange={(value) => {
                if (value === "on" || value === "off")
                  setLoadAllChatGPTSessionsOnStartup(value === "on");
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="Load all ChatGPT sessions on startup">
                <SelectValue>
                  {loadAllChatGPTSessionsOnStartup ? "On" : "Off (default)"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="off">Off (default)</SelectItem>
                <SelectItem value="on">On</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="omniwork-errored-session-order"
          title="Errored ChatGPT sessions"
          description="Choose whether errored sessions remain with their project groups or always float below idle sessions."
          control={
            <Select
              value={erroredSessionsAtBottom ? "bottom" : "project"}
              onValueChange={(value) => setErroredSessionsAtBottom(value !== "project")}
            >
              <SelectTrigger size="sm" aria-label="Errored ChatGPT session sorting">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="bottom">Always at bottom (default)</SelectItem>
                <SelectItem value="project">Follow projects</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="omniwork-chatgpt-warm-count"
          title="Minimum warm ChatGPT sessions"
          description="Automatically warm up to this baseline (default 8). Zero disables background warming; manually opened sessions remain available."
          control={
            <Select
              value={String(chatGPTWarmSessionCount)}
              onValueChange={(value) => {
                if (value !== null) setChatGPTWarmSessionCount(Number(value));
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="Minimum warm ChatGPT sessions">
                <SelectValue>
                  {chatGPTWarmSessionCount === 0 ? "Off" : String(chatGPTWarmSessionCount)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {CHATGPT_WARM_SESSION_COUNTS.map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count === 0 ? "Off" : count === 8 ? "8 (default)" : String(count)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="omniwork-chatgpt-max-auto-count"
          title="Maximum automatically retained sessions"
          description="Soft limit (default 12): opening sessions always works. Above this limit, T3 unloads only verified light-grey idle sessions with empty composers; active/error sessions remain loaded."
          control={
            <Select
              value={String(chatGPTMaxAutoSessionCount)}
              onValueChange={(value) => {
                if (value !== null) setChatGPTMaxAutoSessionCount(Number(value));
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="Maximum automatically retained ChatGPT sessions">
                <SelectValue>{String(chatGPTMaxAutoSessionCount)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {CHATGPT_WARM_SESSION_COUNTS.filter((count) => count >= chatGPTWarmSessionCount).map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count === 12 ? "12 (default)" : String(count)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title="Live tasks">
        <SettingsRow
          id="omniwork-live-task-runtime"
          title="Live tasks start as"
          description="Default agent type for starting a task without an existing session. A Start action can override it."
          control={
            <Select
              value={liveTaskStartKind}
              onValueChange={(value) => {
                if (value === "chatgpt" || value === "claude" || value === "codex")
                  setLiveTaskStartKind(value);
              }}
              disabled={!desktop}
            >
              <SelectTrigger size="sm" aria-label="Live tasks start as">
                <SelectValue>
                  {liveTaskStartKind === "chatgpt"
                    ? "ChatGPT"
                    : liveTaskStartKind === "claude"
                      ? "Claude"
                      : "Codex"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="chatgpt">ChatGPT</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <OmniworkToolsSection />
    </SettingsPageContainer>
  );
}
