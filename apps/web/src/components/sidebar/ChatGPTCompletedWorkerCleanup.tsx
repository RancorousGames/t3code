import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import {
  completedWorkerCandidate,
  type WorkerCreationEvidence,
} from "../../chatGPTCompletedWorkerPolicy";
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import { isChatGPTGuestHibernated } from "../../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
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

/** Cleanup reads ALL persisted sessions independent of Hide Workers/search.
 * It never mounts unloaded guests merely to decide whether to close them.
 */
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
      const receiptCreatedAt = new Map(
        readChatGPTSpawnReceipts(environmentId).map((r) => [r.sessionId, r.createdAt]),
      );
      const initial = readChatGPTBrowserSessions(environmentId);
      const creationEvidence = (id: string): WorkerCreationEvidence => {
        const spawnCreatedAt = receiptCreatedAt.get(id);
        const lastWorkingAt = getLocalStorageItem(
          chatGPTBrowserLastWorkingKey(environmentId, id),
          Schema.Number,
        );
        return {
          ...(spawnCreatedAt === undefined ? {} : { spawnCreatedAt }),
          ...(lastWorkingAt === null ? {} : { lastWorkingAt }),
        };
      };

      for (const worker of initial) {
        if (unmounted) return;
        const originalCandidate = completedWorkerCandidate(
          initial,
          worker,
          claims,
          managerIds,
          selectedBrowserSessionId(),
          Date.now(),
          creationEvidence(worker.id),
        );
        if (!originalCandidate || hasUncertainChatGPTSend(environmentId, worker.id)) continue;

        const status = await inspectBrowserSession(environmentId, worker);
        // The host can report "unloaded" for a deferred guest. Its status
        // contract is being widened in another owned recovery change.
        const observedStatus: string = status.status;
        const thread = chatGPTBrowserThreadRef(environmentId, worker.id);
        const preview = readThreadPreviewState(thread);
        const snapshots = Object.values(preview.sessions);
        if (snapshots.length > 1) continue;
        const snapshot = snapshots[0] ?? null;
        const runtimeId = snapshot && preview.serverEpoch
          ? previewRuntimeTabId(thread, preview.serverEpoch, snapshot.tabId)
          : null;
        const cachedUrl = getLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, worker.id),
          Schema.String,
        );
        const conversationId = chatGPTConversationIdFromUrl(cachedUrl);

        // A cold worker has no mounted composer. Before deleting its T3 slot,
        // require a canonical persisted conversation URL, no guest, no pending
        // send fence, and a stable preview URL when a preview still exists.
        const noMountedGuest =
          !runtimeId ||
          !Array.from(document.querySelectorAll("webview")).some(
            (guest) => guest.dataset.previewTab === runtimeId,
          );
        const coldClose =
          (observedStatus === "unloaded" || observedStatus === "hibernated") &&
          noMountedGuest &&
          conversationId !== null &&
          (snapshot === null
            ? observedStatus === "unloaded" && runtimeId === null
            : runtimeId !== null &&
              (observedStatus === "unloaded" || isChatGPTGuestHibernated(runtimeId)) &&
              preview.activeTabId === snapshot.tabId &&
              snapshot.navStatus._tag === "Success" &&
              chatGPTConversationIdFromUrl(snapshot.navStatus.url) === conversationId);

        const liveClose =
          snapshot !== null &&
          (status.status === "done_or_idle" || status.status === "waiting_for_input") &&
          status.activity === "idle" &&
          status.uiColor !== "interrupted" &&
          !!status.observedGuestUrl;
        if (!liveClose && !coldClose) continue;

        try {
          // Recheck the entire claim set, role, timers, exemptions and session
          // identity after asynchronous host/UI operations. A sidebar click
          // does NOT make a session human-controlled.
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
              creationEvidence(current.id),
            )
          ) continue;

          if (liveClose) {
            // A loaded guest requires two affirmative empty-composer probes
            // and stable exact identity through the existing close preflight.
            await runChatGPTSessionControl({
              environmentId,
              sessions: currentSessions,
              sessionId: current.id,
              action: "change_state",
              state: "closed",
              neverWake: true,
            });
          }

          if (coldClose) {
            const latest = await inspectBrowserSession(environmentId, current);
            if (
              latest.status !== status.status ||
              hasUncertainChatGPTSend(environmentId, current.id) ||
              (runtimeId && Array.from(document.querySelectorAll("webview")).some(
                (guest) => guest.dataset.previewTab === runtimeId,
              ))
            ) continue;
          }

          const latestPreview = readThreadPreviewState(thread);
          if (
            unmounted ||
            hasUncertainChatGPTSend(environmentId, current.id) ||
            selectedBrowserSessionId() === current.id ||
            JSON.stringify(readChatGPTBrowserSessions(environmentId).find(
              (entry) => entry.id === current.id,
            )) !== JSON.stringify(current) ||
            (snapshot !== null
              ? latestPreview.sessions[snapshot.tabId] !== snapshot
              : Object.keys(latestPreview.sessions).length !== 0) ||
            (coldClose &&
              (getLocalStorageItem(
                chatGPTBrowserLastUrlKey(environmentId, current.id),
                Schema.String,
              ) !== cachedUrl ||
              (runtimeId !== null && status.status === "hibernated" &&
                !isChatGPTGuestHibernated(runtimeId))))
          ) continue;

          if (snapshot !== null) {
            const result = await closePreviewSession({
              closePreview: close,
              snapshot,
              tabId: snapshot.tabId,
              threadRef: thread,
            });
            if (result._tag === "Failure") continue;
          }
          // At most one local container removed per scan. The conversation
          // remains on ChatGPT's servers; never archive/hide instead of close.
          removeSession(current.id, "completed-worker");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, current.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, current.id));
          console.info("[ChatGPT completed-worker cleanup]", {
            sessionId: current.id,
            taskIds: originalCandidate.taskIds,
            dueAt: originalCandidate.dueAt,
            reason: originalCandidate.reason,
          });
          return;
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
