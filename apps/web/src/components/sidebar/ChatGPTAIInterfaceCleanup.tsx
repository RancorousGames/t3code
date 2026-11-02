import type { EnvironmentId } from "@t3tools/contracts";
import { chatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { aiInterfaceCloseDue, isAIInterfaceSession } from "../../chatGPTAIInterfaceSessions";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  hasUncertainChatGPTSend, inspectBrowserSession, runChatGPTSessionControl,
} from "../../chatGPTSessionControl";
import { readThreadPreviewState } from "../../previewStateStore";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { nativeChatGPTResidency } from "../../browser/nativeChatGPTWarmSession";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";

/** Separate lifetime for provider API guests, independent of worker cleanup.
 * Close the T3 container only after idle evidence and empty-composer checks.
 * Never delete ChatGPT's remote conversation or replay unknown delivery.
 */
export function ChatGPTAIInterfaceCleanup({
  environmentId, activeSessionId, now,
}: {
  environmentId: EnvironmentId;
  activeSessionId: string | undefined;
  now: number;
}) {
  const { removeSession } = useChatGPTBrowserSessions(environmentId);
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const scanning = useRef(false);
  const lastScan = useRef(0);

  useEffect(() => {
    if (scanning.current || now - lastScan.current < 50_000) return;
    scanning.current = true;
    lastScan.current = now;
    let disposed = false;
    const scan = async () => {
      for (const original of readChatGPTBrowserSessions(environmentId)) {
        if (disposed) return;
        if (!isAIInterfaceSession(original)) continue;
        const lastWorking = getLocalStorageItem(
          chatGPTBrowserLastWorkingKey(environmentId, original.id), Schema.Number,
        );
        const lastActivityAt = Math.max(
          original.createdAt ?? 0, original.lastDirectInteractionAt ?? 0,
          lastWorking ?? 0,
        ) || null;
        if (!aiInterfaceCloseDue(original, lastActivityAt, now,
          activeSessionId === original.id) ||
          hasUncertainChatGPTSend(environmentId, original.id))
          continue;
        const thread = chatGPTBrowserThreadRef(environmentId, original.id);
        const preview = readThreadPreviewState(thread);
        const tabs = Object.values(preview.sessions);
        if (tabs.length > 1) continue;
        const snapshot = tabs[0] ?? null;
        try {
          const inspected = await inspectBrowserSession(environmentId, original);
          if (disposed || inspected.activity !== "idle" ||
            inspected.uiColor === "interrupted" ||
            inspected.status === "working" ||
            inspected.status === "pending_or_stalled")
            continue;
          const current = readChatGPTBrowserSessions(environmentId).find(
            (entry) => entry.id === original.id,
          );
          if (!current || JSON.stringify(current) !== JSON.stringify(original) ||
              hasUncertainChatGPTSend(environmentId, original.id) ||
              window.location.pathname.includes(`/browser/${original.id}`))
            continue;
          // The existing close control refuses drafts, uncertain sends and
          // active composers. Cold guests without a preview are safe to remove.
          const native = isPersistentChatGPTSessionOptedIn(original.id);
          const nativeBridge = native ? window.desktopBridge?.stableChatGPTViewRequest : undefined;
          const nativeState = nativeBridge
            ? await nativeChatGPTResidency(nativeBridge, environmentId, original.id)
            : native ? "unknown" : null;
          if (native && nativeState === "unknown") continue;
          if (native && nativeState === "missing") {
            // A missing native owner is not evidence that a background
            // composer was empty; leave its record for explicit review.
            continue;
          }
          if (native || snapshot !== null || inspected.status !== "unloaded") {
            await runChatGPTSessionControl({
              environmentId, sessions: readChatGPTBrowserSessions(environmentId),
              action: "change_state", sessionId: original.id,
              state: "closed", neverWake: true,
            });
          }
          if (snapshot !== null) {
            const latest = readThreadPreviewState(thread);
            if (latest.sessions[snapshot.tabId] !== snapshot) continue;
            const closed = await closePreviewSession({
              closePreview: close, snapshot, tabId: snapshot.tabId, threadRef: thread,
            });
            if (closed._tag === "Failure") continue;
          }
          if (disposed || hasUncertainChatGPTSend(environmentId, original.id) ||
              window.location.pathname.includes(`/browser/${original.id}`))
            continue;
          if (nativeBridge && nativeState === "resident") {
            // The guarded change_state preflight above verified the exact
            // conversation and empty composer; remove its actual owner too.
            await nativeBridge({ operation: "close", identity: {
              environmentId, sessionId: original.id, profileId: chatGPTSessionProfileId(original),
            } });
          }
          removeSession(original.id, "completed-worker");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, original.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, original.id));
          return; // One local container per scan.
        } catch (error) {
          console.warn("[AI interface cleanup] Skipped unsafe close", original.id, error);
        }
      }
    };
    void scan().finally(() => { scanning.current = false; });
    return () => { disposed = true; };
  }, [environmentId, activeSessionId, now, close, removeSession]);
  return null;
}
