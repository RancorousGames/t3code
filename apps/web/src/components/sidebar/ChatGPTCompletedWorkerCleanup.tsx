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
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import { auditBlankChatGPTWorkers } from "../../chatGPTWorkerStartupDiagnostics";
import {
  clearSpawnAutoCloseIdleSince,
  readSpawnAutoCloseIdleSince,
  spawnAutoCloseCandidate,
} from "../../chatGPTSpawnAutoClose";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";

import { readThreadPreviewState } from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";

/** Cleanup reads ALL persisted sessions independent of Hide Workers/search.
 * It never mounts unloaded guests merely to decide whether to close them.
 */
export function ChatGPTCompletedWorkerCleanup({
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
  // A background cleanup must never remove the session the user is viewing.
  // Re-read selection after awaits: the user may select a candidate mid-scan.
  const selectedSessionId = useRef(activeSessionId);
  selectedSessionId.current = activeSessionId;
  const { removeSession } = useChatGPTBrowserSessions(environmentId);
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const scanning = useRef(false);
  const lastScan = useRef(0);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [environmentId],
  );

  useEffect(() => {
    if (scanning.current || now - lastScan.current < 20_000) return;
    const verifiedManagers = managerIds;
    scanning.current = true;
    lastScan.current = now;
    const currentGeneration = generation.current;
    const unmounted = () => generation.current !== currentGeneration;
    const scan = async () => {
      const receiptCreatedAt = new Map(
        readChatGPTSpawnReceipts(environmentId).map((r) => [r.sessionId, r.createdAt]),
      );
      const initial = readChatGPTBrowserSessions(environmentId);
      auditBlankChatGPTWorkers(
        environmentId,
        initial,
        readChatGPTSpawnReceipts(environmentId),
        Date.now(),
      );
      const creationEvidence = (id: string) => {
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

      const candidateFor = (
        sessions: readonly (typeof initial)[number][],
        worker: (typeof initial)[number],
        at: number,
      ) =>
        verifiedManagers?.has(worker.id) || selectedSessionId.current === worker.id
          ? null
          : spawnAutoCloseCandidate(
              sessions,
              worker,
              at,
              readSpawnAutoCloseIdleSince(environmentId, worker.id),
              creationEvidence(worker.id).lastWorkingAt ?? null,
              creationEvidence(worker.id).spawnCreatedAt ?? null,
            );
      for (const worker of initial) {
        if (unmounted()) return;
        const originalCandidate = candidateFor(initial, worker, Date.now());
        if (!originalCandidate || hasUncertainChatGPTSend(environmentId, worker.id)) continue;

        const thread = chatGPTBrowserThreadRef(environmentId, worker.id);
        try {
          // Expiry is based on persisted worker activity, not a mounted guest's
          // browser status. Recheck after awaits so active or exempt workers survive.
          const currentSessions = readChatGPTBrowserSessions(environmentId);
          const current = currentSessions.find((entry) => entry.id === worker.id);
          if (
            unmounted() ||
            !current ||
            JSON.stringify(current) !== JSON.stringify(worker) ||
            hasUncertainChatGPTSend(environmentId, worker.id) ||
            !candidateFor(currentSessions, current, Date.now())
          )
            continue;

          // Release any open preview tabs before removing the local T3 session.
          // No guest inspection is needed, including for unloaded previews.
          let failed = false;
          for (const snapshot of Object.values(readThreadPreviewState(thread).sessions)) {
            const freshSessions = readChatGPTBrowserSessions(environmentId);
            if (
              unmounted() ||
              JSON.stringify(freshSessions.find((entry) => entry.id === current.id)) !==
                JSON.stringify(current) ||
              hasUncertainChatGPTSend(environmentId, current.id) ||
              !candidateFor(freshSessions, current, Date.now())
            ) {
              failed = true;
              break;
            }
            const result = await closePreviewSession({
              closePreview: close,
              snapshot,
              tabId: snapshot.tabId,
              threadRef: thread,
            });
            if (result._tag === "Failure") {
              failed = true;
              break;
            }
          }
          if (failed) continue;

          const latestSessions = readChatGPTBrowserSessions(environmentId);
          if (
            unmounted() ||
            hasUncertainChatGPTSend(environmentId, current.id) ||
            JSON.stringify(latestSessions.find((entry) => entry.id === current.id)) !==
              JSON.stringify(current) ||
            !candidateFor(latestSessions, current, Date.now())
          )
            continue;
          // At most one local container removed per scan. The conversation
          // remains on ChatGPT's servers; never archive/hide instead of close.
          if (selectedSessionId.current === current.id) continue;
          removeSession(current.id, "completed-worker");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, current.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, current.id));
          clearSpawnAutoCloseIdleSince(environmentId, current.id);
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
        console.warn("[ChatGPT worker cleanup] Unable to close expired worker", error);
      })
      .finally(() => {
        scanning.current = false;
      });
  }, [environmentId, managerIds, now, close, removeSession]);
  return null;
}
