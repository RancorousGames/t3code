import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import {
  chatGPTGuestTouchedAt,
  isChatGPTGuestHibernated,
} from "../../browser/chatGPTGuestHibernation";
import { useBrowserSurfaceStore } from "../../browser/browserSurfaceStore";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { isChatGPTHomeUrl } from "../../chatGPTBrowserPrewarm";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { hasVerifiedUnusedNewChatGuest } from "../../chatGPTDraftInspection";
import { readChatGPTRecoveryState } from "../../chatGPTRecoveryDiagnostics";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import {
  EMPTY_MANUAL_CHAT_MAX_IDLE_MS,
  emptyManualChatEligibility,
} from "../../chatGPTUnusedManualSessionPolicy";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { readThreadPreviewState } from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";

/** Inspection timeout is a refusal, not a reason to reload or reset the guest. */
async function provenUnusedGuest(
  guest: HTMLElementTagNameMap["webview"],
  url: string,
): Promise<boolean> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () =>
        (await guest.executeJavaScript(CHATGPT_ACTIVITY_EXPRESSION)) === "idle" &&
        (await hasVerifiedUnusedNewChatGuest(guest, url)))(),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 4_000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

function recoveryPending(environmentId: EnvironmentId, sessionId: string): boolean {
  const state = readChatGPTRecoveryState(environmentId, sessionId);
  return (
    state.orangeStage !== null ||
    state.retryCount > 0 ||
    state.nextRetryAt !== null ||
    state.escalationReason !== null
  );
}

/**
 * Runs on the sidebar's existing minute heartbeat. Never mounts/wakes a guest,
 * focuses a window or deletes a session based on the stored homepage URL alone.
 * Legacy sessions and any unverifiable fresh chat are deliberately left alone.
 */
export function ChatGPTUnusedManualSessionCleanup({
  environmentId,
  activeSessionId,
  managerIds,
  now,
}: {
  environmentId: EnvironmentId;
  activeSessionId: string | undefined;
  managerIds: ReadonlySet<string> | null;
  now: number;
}) {
  const { sessions, removeSession } = useChatGPTBrowserSessions(environmentId);
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const scanning = useRef(false);

  useEffect(() => {
    if (scanning.current || managerIds === null) return;
    let cancelled = false;
    scanning.current = true;
    const scan = async () => {
      const spawnedIds = new Set(
        readChatGPTSpawnReceipts(environmentId).map((receipt) => receipt.sessionId),
      );
      // At most one removal per tick: each successful close updates the session
      // index and prompts another evaluation on the next render.
      for (const session of sessions) {
        if (cancelled) return;
        if (
          !session.manualEmptyCandidateCreatedAt ||
          now - session.manualEmptyCandidateCreatedAt < EMPTY_MANUAL_CHAT_MAX_IDLE_MS
        )
          continue;
        const thread = chatGPTBrowserThreadRef(environmentId, session.id);
        const preview = readThreadPreviewState(thread);
        const tabId = preview.activeTabId;
        const runtimeId =
          tabId && preview.serverEpoch
            ? previewRuntimeTabId(thread, preview.serverEpoch, tabId)
            : null;
        const cachedUrl = getLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, session.id),
          Schema.String,
        );
        const rejected = emptyManualChatEligibility({
          session,
          sessions,
          now,
          lastTouchedAt: runtimeId ? (chatGPTGuestTouchedAt(runtimeId) ?? 0) : 0,
          activeSessionId,
          managerIds,
          hasUncertainSend:
            hasUncertainChatGPTSend(environmentId, session.id) || spawnedIds.has(session.id),
          recoveryPending: recoveryPending(environmentId, session.id),
          hasConversationUrl: isChatGPTConversationUrl(cachedUrl),
        });
        if (rejected !== "eligible" || !tabId || !runtimeId) continue;
        const snapshot = preview.sessions[tabId];
        const nav = snapshot?.navStatus;
        if (
          Object.keys(preview.sessions).length !== 1 ||
          !snapshot ||
          nav?._tag !== "Success" ||
          !isChatGPTHomeUrl(nav.url) ||
          preview.desktopByTabId[tabId]?.loading !== false ||
          preview.desktopByTabId[tabId]?.hasWebContents !== true ||
          isChatGPTGuestHibernated(runtimeId) ||
          useBrowserSurfaceStore.getState().byTabId[runtimeId]?.visible !== false
        )
          continue;

        const guest = Array.from(document.querySelectorAll("webview")).find(
          (node) => node.dataset.previewTab === runtimeId,
        );
        if (!guest) continue;
        try {
          if (!(await provenUnusedGuest(guest, nav.url))) continue;

          // A user might select a tab, start a send, attach a file, or spawn a
          // child during the probes. Recheck persisted metadata and guest state.
          const latestSessions = readChatGPTBrowserSessions(environmentId);
          const current = latestSessions.find((entry) => entry.id === session.id);
          const latest = readThreadPreviewState(thread);
          const latestNav = latest.sessions[tabId]?.navStatus;
          if (
            cancelled ||
            !current ||
            JSON.stringify(current) !== JSON.stringify(session) ||
            emptyManualChatEligibility({
              session: current,
              sessions: latestSessions,
              now: Date.now(),
              lastTouchedAt: chatGPTGuestTouchedAt(runtimeId) ?? 0,
              activeSessionId,
              managerIds,
              hasUncertainSend:
                hasUncertainChatGPTSend(environmentId, session.id) ||
                readChatGPTSpawnReceipts(environmentId).some((r) => r.sessionId === session.id),
              recoveryPending: recoveryPending(environmentId, session.id),
              hasConversationUrl: isChatGPTConversationUrl(
                getLocalStorageItem(
                  chatGPTBrowserLastUrlKey(environmentId, session.id),
                  Schema.String,
                ),
              ),
            }) !== "eligible" ||
            latest.activeTabId !== tabId ||
            latest.sessions[tabId] !== snapshot ||
            latestNav?._tag !== "Success" ||
            latestNav.url !== nav.url ||
            isChatGPTGuestHibernated(runtimeId) ||
            useBrowserSurfaceStore.getState().byTabId[runtimeId]?.visible !== false ||
            !document.contains(guest) ||
            !(await provenUnusedGuest(guest, nav.url))
          )
            continue;

          const result = await closePreviewSession({
            closePreview: close,
            snapshot,
            tabId,
            threadRef: thread,
          });
          if (result._tag === "Failure" || cancelled) continue;
          // Closing a preview does not itself delete any ChatGPT conversation.
          removeSession(session.id, "unused-empty-manual");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, session.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, session.id));
          console.info("[ChatGPT unused-new-chat cleanup]", {
            sessionId: session.id,
            reason:
              "explicitly user-created, idle 30+ minutes; pristine home, no turns, no draft or attachments (double-probed)",
          });
          return;
        } catch {
          // Lost renderer/guest or failed close is not proof of an empty chat.
        }
      }
    };
    void scan()
      .catch(() => {
        // Corrupt storage or an unavailable preview is not evidence for removal.
      })
      .finally(() => {
        scanning.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, close, environmentId, managerIds, now, removeSession, sessions]);
  return null;
}
