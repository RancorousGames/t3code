import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { chatGPTBrowserThreadRef, isChatGPTConversationUrl } from "../../chatGPTBrowserSessions";
import { readThreadPreviewState } from "../../previewStateStore";
import { previewBridge } from "../preview/previewBridge";
import {
  CHATGPT_LOAD_FAILURE_EXPRESSION,
  RECOVERY_GLOBAL_MS,
  RECOVERY_PER_SESSION_MS,
  RECOVERY_SCAN_MS,
  cooldownElapsed,
  orderedCandidates,
  readRecentSessionClicks,
  readRecoveryHistory,
  recordRecoveryAttempt,
} from "./chatGPTConversationRecovery";

// One scanner for the entire sidebar, not a timer per ChatGPT tab.
let scanning = false;

export function ChatGPTBrowserRecoveryCoordinator({
  environmentId,
  sessionIds,
  deferredIds = [],
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionIds: readonly string[];
  readonly deferredIds?: readonly string[];
}) {
  const currentSessionIds = useEffectEvent(() => sessionIds);
  const currentDeferredIds = useEffectEvent(() => deferredIds);

  useEffect(() => {
    if (!previewBridge) return;
    const bridge = previewBridge;
    const envId = environmentId;
    let disposed = false;

    const scan = async () => {
      if (disposed || scanning) return;
      scanning = true;
      try {
        const now = Date.now();
        const history = readRecoveryHistory(envId);
        if (!cooldownElapsed(history.lastAttemptAt, now, RECOVERY_GLOBAL_MS)) return;

        // sessionIds contains visible sessions only. Never inspect or refresh
        // hidden sessions, even if they remain in the persisted click history.
        const clicked = readRecentSessionClicks(envId);
        for (const sessionId of orderedCandidates(
          currentSessionIds(),
          history,
          clicked,
          new Set(currentDeferredIds()),
        )) {
          if (disposed) return;
          if (!currentSessionIds().includes(sessionId)) continue;
          if (!cooldownElapsed(history.bySession[sessionId] ?? 0, now, RECOVERY_PER_SESSION_MS))
            continue;

          const threadRef = chatGPTBrowserThreadRef(envId, sessionId);
          const state = readThreadPreviewState(threadRef);
          const tabId = state.activeTabId;
          if (!tabId || !state.serverEpoch) continue;
          const overlay = state.desktopByTabId[tabId];
          const nav = state.sessions[tabId]?.navStatus;
          if (
            !overlay?.hasWebContents ||
            overlay.loading ||
            nav?._tag !== "Success" ||
            !isChatGPTConversationUrl(nav.url)
          )
            continue;

          const runtimeId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
          const webview = Array.from(document.querySelectorAll("webview")).find(
            (element) => element.dataset.previewTab === runtimeId,
          );
          if (!webview) continue;

          let failed = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            // A hung guest must not stall every other session indefinitely.
            const inspected = await Promise.race([
              webview.executeJavaScript(CHATGPT_LOAD_FAILURE_EXPRESSION),
              new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), 4_000);
              }),
            ]);
            failed = inspected === true;
          } catch {
            // Guest navigation, detach, or a transient DOM inspection error.
            continue;
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
          if (!failed || disposed || !currentSessionIds().includes(sessionId)) continue;

          // The page may have navigated during the DOM inspection. Never refresh
          // a live/working conversation on the basis of an obsolete error.
          const latest = readThreadPreviewState(threadRef);
          const current = latest.sessions[tabId]?.navStatus;
          if (
            !currentSessionIds().includes(sessionId) ||
            latest.activeTabId !== tabId ||
            latest.serverEpoch !== state.serverEpoch ||
            !latest.desktopByTabId[tabId]?.hasWebContents ||
            latest.desktopByTabId[tabId]?.loading ||
            current?._tag !== "Success" ||
            current.url !== nav.url
          )
            continue;
          const recent = readRecoveryHistory(envId);
          const attemptedAt = Date.now();
          if (
            !cooldownElapsed(recent.lastAttemptAt, attemptedAt, RECOVERY_GLOBAL_MS) ||
            !cooldownElapsed(recent.bySession[sessionId] ?? 0, attemptedAt, RECOVERY_PER_SESSION_MS)
          )
            continue;

          // Persist BEFORE refreshing. A stalled refresh, failed network request
          // or T3 restart must not create a retry storm against ChatGPT.
          recordRecoveryAttempt(envId, sessionId, attemptedAt, currentSessionIds());
          try {
            await bridge.refresh(runtimeId);
          } catch (error) {
            console.warn("[ChatGPT recovery] Refresh failed:", error);
          }
          return; // At most ONE session refreshed per scan.
        }
      } finally {
        scanning = false;
      }
    };

    // Let the browser runtimes attach and settle before the first inspection.
    const initial = setTimeout(() => void scan(), 20_000);
    const interval = setInterval(() => void scan(), RECOVERY_SCAN_MS);
    return () => {
      disposed = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [environmentId]);

  return null;
}
