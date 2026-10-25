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
import {
  hasUncertainChatGPTSend,
  inspectBrowserSession,
  runChatGPTSessionControl,
} from "../../chatGPTSessionControl";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
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
        // A pending/working ChatGPT answer continues remotely after closing
        // the T3 guest. Only an unreadable, interrupted or unloaded guest blocks.
        if (
          !["done_or_idle", "waiting_for_input", "working", "pending_or_stalled"].includes(
            status.status,
          ) ||
          status.uiColor === "interrupted" ||
          !status.observedGuestUrl
        )
          continue;
        const thread = chatGPTBrowserThreadRef(environmentId, worker.id);
        const preview = readThreadPreviewState(thread);
        const snapshots = Object.values(preview.sessions);
        if (snapshots.length !== 1) continue;
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
          await runChatGPTSessionControl({
            environmentId,
            sessions: currentSessions,
            sessionId: current.id,
            action: "change_state",
            state: "closed",
            neverWake: true,
          });
          if (
            unmounted ||
            hasUncertainChatGPTSend(environmentId, current.id) ||
            selectedBrowserSessionId() === current.id ||
            JSON.stringify(
              readChatGPTBrowserSessions(environmentId).find((entry) => entry.id === current.id),
            ) !== JSON.stringify(current) ||
            readThreadPreviewState(thread).sessions[snapshots[0]!.tabId] !== snapshots[0]
          )
            continue;
          const result = await closePreviewSession({
            closePreview: close,
            snapshot: snapshots[0]!,
            tabId: snapshots[0]!.tabId,
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
