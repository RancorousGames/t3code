import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { recoverSelectedBlankChatGPTSession } from "../../chatGPTSelectedSessionRecovery";
import { readChatGPTRecoverySettings } from "../../chatGPTRecoverySettings";
import { readChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { inspectBrowserSession, runChatGPTSessionControl } from "../../chatGPTSessionControl";
import { isSelectedChatGPTError } from "../../chatGPTSelectedErrorRecovery";

/** Selection is the user-triggered high-priority recovery path. */
export function ChatGPTBrowserSelectionRecovery({
  environmentId,
  sessionId,
  enabled,
  clickToken,
}: {
  environmentId: EnvironmentId;
  sessionId?: string | undefined;
  enabled: boolean;
  clickToken: number;
}) {
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let mounted = true;
    const current = () => mounted && !!document.querySelector("body");
    let inFlight = false;
    let lastAttempt = 0;
    void recoverSelectedBlankChatGPTSession({
      environmentId, sessionId, isCurrent: current,
    }).catch((error: unknown) => {
      if (mounted)
        console.warn("[ChatGPT selected blank recovery] Could not inspect selected session:", error);
    });
    // Selection is a separate explicit user intent. Pausing background recovery
    // must not strand the one selected red session. Never scan other sessions.
    const retrySelected = async () => {
      if (!current() || inFlight || !readChatGPTRecoverySettings().paused) return;
      if (Date.now() - lastAttempt < 30_000) return;
      inFlight = true;
      try {
        const sessions = readChatGPTBrowserSessions(environmentId);
        const entry = sessions.find(s => s.id === sessionId && !s.hidden &&
          !(s.snoozedUntil && s.snoozedUntil > Date.now()));
        if (!entry) return;
        const inspection = await inspectBrowserSession(environmentId, entry);
        if (!current() || !readChatGPTRecoverySettings().paused ||
            !isSelectedChatGPTError(inspection)) return;
        lastAttempt = Date.now();
        await runChatGPTSessionControl({
          environmentId, sessions: readChatGPTBrowserSessions(environmentId),
          sessionId, action: "reload", force: false, shouldContinue: current,
        });
      } catch (error) {
        if (mounted)
          console.debug("[ChatGPT selected recovery] Guarded retry unavailable:", error);
      } finally { inFlight = false; }
    };
    const timer = window.setInterval(() => void retrySelected(), 10_000);
    void retrySelected();
    return () => { mounted = false; window.clearInterval(timer); };
  }, [environmentId, sessionId, enabled, clickToken]);
  return null;
}
