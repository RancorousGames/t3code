import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { completedWorkerCandidate } from "../../chatGPTCompletedWorkerPolicy";
import { isChatGPTGuestHibernated } from "../../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import {
  hasUncertainChatGPTSend,
  inspectBrowserSession,
  runChatGPTSessionControl,
} from "../../chatGPTSessionControl";

import { readThreadPreviewState } from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";

function selectedBrowserSessionId(): string | undefined {
  const match = /\/browser\/([^/?#]+)/.exec(window.location.pathname);
  return match?.[1];
}

/** T3 owns the 1-minute cleanup scan; completion is read from local TaskBoard
 * frontmatter rather than trusting a worker's own claim to be Done. */
export function ChatGPTCompletedWorkerCleanup({
  environmentId,
  managerIds,
  now,
}: {
  environmentId: EnvironmentId;
  managerIds: ReadonlySet<string> | null;
  now: number;
}) {
  const { removeSession } = useChatGPTBrowserSessions(environmentId);
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const scanning = useRef(false);
  const lastScan = useRef(0);

  useEffect(() => {
    const read = window.desktopBridge?.readTaskBoardWorkerClaims;
    if (!read || managerIds === null || scanning.current || now - lastScan.current < 50_000) return;
    scanning.current = true;
    lastScan.current = now;
    let unmounted = false;
    const scan = async () => {
      const claims = await read();
      const initial = readChatGPTBrowserSessions(environmentId);
      for (const worker of initial) {
        if (unmounted) return;
        const originalCandidate = completedWorkerCandidate(
          initial,
          worker,
          claims,
          managerIds,
          selectedBrowserSessionId(),
          Date.now(),
        );
        if (!originalCandidate) continue;
        if (hasUncertainChatGPTSend(environmentId, worker.id)) continue;
        const status = await inspectBrowserSession(environmentId, worker);
        const thread = chatGPTBrowserThreadRef(environmentId, worker.id);
        const preview = readThreadPreviewState(thread);
        const snapshots = Object.values(preview.sessions);
        if (snapshots.length !== 1) continue;
        const snapshot = snapshots[0]!;
        const runtimeId = preview.serverEpoch
          ? previewRuntimeTabId(thread, preview.serverEpoch, snapshot.tabId)
          : null;
        // Hibernation itself only happens after observed idle. An already
        // unmounted guest holds no local live composer; never wake/reload it to
        // clean up an obsolete local sidebar slot. Its remote ChatGPT history
        // remains intact. Both the cached and preview URLs must agree.
        const cachedUrl = getLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, worker.id),
          Schema.String,
        );
        const conversationId = chatGPTConversationIdFromUrl(cachedUrl);
        const coldClosed =
          status.status === "hibernated" &&
          runtimeId !== null &&
          isChatGPTGuestHibernated(runtimeId) &&
          !Array.from(document.querySelectorAll("webview")).some(
            (guest) => guest.dataset.previewTab === runtimeId,
          ) &&
          preview.activeTabId === snapshot.tabId &&
          snapshot.navStatus._tag === "Success" &&
          conversationId !== null &&
          chatGPTConversationIdFromUrl(snapshot.navStatus.url) === conversationId;
        const liveClosable =
          ["done_or_idle", "waiting_for_input", "working", "pending_or_stalled"].includes(
            status.status,
          ) &&
          status.uiColor !== "interrupted" &&
          !!status.observedGuestUrl;
        if (!liveClosable && !coldClosed) continue;
        try {
          // The board may be reopened while a user inspects the worker.
          const refreshedClaims = await read();
          const currentSessions = readChatGPTBrowserSessions(environmentId);
          const current = currentSessions.find((entry) => entry.id === worker.id);
          if (
            unmounted ||
            !current ||
            JSON.stringify(current) !== JSON.stringify(worker) ||
            !completedWorkerCandidate(
              currentSessions,
              current,
              refreshedClaims,
              managerIds,
              selectedBrowserSessionId(),
              Date.now(),
            )
          )
            continue;
          if (liveClosable) {
            // Loaded guests require two affirmative empty-composer probes,
            // stable identity and the existing durable UNKNOWN-send fences.
            await runChatGPTSessionControl({
              environmentId,
              sessions: currentSessions,
              sessionId: current.id,
              action: "change_state",
              state: "closed",
              neverWake: true,
            });
          }
          if (
            unmounted ||
            hasUncertainChatGPTSend(environmentId, current.id) ||
            selectedBrowserSessionId() === current.id ||
            JSON.stringify(
              readChatGPTBrowserSessions(environmentId).find((entry) => entry.id === current.id),
            ) !== JSON.stringify(current) ||
            readThreadPreviewState(thread).sessions[snapshot.tabId] !== snapshot ||
            (coldClosed &&
              (!runtimeId ||
                !isChatGPTGuestHibernated(runtimeId) ||
                Array.from(document.querySelectorAll("webview")).some(
                  (guest) => guest.dataset.previewTab === runtimeId,
                )))
          )
            continue;
          const result = await closePreviewSession({
            closePreview: close,
            snapshot,
            tabId: snapshot.tabId,
            threadRef: thread,
          });
          if (result._tag === "Failure") continue;
          // A close only removes the local T3 container; ChatGPT retains history.
          removeSession(current.id, "completed-worker");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, current.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, current.id));
          console.info("[ChatGPT completed-worker cleanup]", {
            sessionId: current.id,
            taskIds: originalCandidate.taskIds,
            dueAt: originalCandidate.dueAt,
          });
          return; // max one close per heartbeat
        } catch (error) {
          console.warn("[ChatGPT completed-worker cleanup] Skipped unsafe close", worker.id, error);
        }
      }
    };
    void scan()
      .catch((error: unknown) => {
        console.warn("[ChatGPT completed-worker cleanup] TaskBoard unavailable; no close", error);
      })
      .finally(() => {
        scanning.current = false;
      });
    return () => {
      unmounted = true;
    };
  }, [environmentId, managerIds, now, close, removeSession]);
  return null;
}
