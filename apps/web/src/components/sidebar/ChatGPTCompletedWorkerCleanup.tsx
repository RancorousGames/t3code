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
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import { auditBlankChatGPTWorkers } from "../../chatGPTWorkerStartupDiagnostics";
import {
  clearSpawnAutoCloseIdleSince,
  readSpawnAutoCloseIdleSince,
  spawnAutoCloseCandidate,
} from "../../chatGPTSpawnAutoClose";
import { isChatGPTGuestHibernated } from "../../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { nativeChatGPTResidency } from "../../browser/nativeChatGPTWarmSession";
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
  useEffect(() => () => { generation.current++; }, [environmentId]);

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
      auditBlankChatGPTWorkers(environmentId, initial, readChatGPTSpawnReceipts(environmentId), Date.now());
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
      ) => verifiedManagers?.has(worker.id) || selectedSessionId.current === worker.id
        ? null : spawnAutoCloseCandidate(
        sessions, worker, at,
        readSpawnAutoCloseIdleSince(environmentId, worker.id),
        creationEvidence(worker.id).lastWorkingAt ?? null,
        creationEvidence(worker.id).spawnCreatedAt ?? null,
      );
      for (const worker of initial) {
        if (unmounted()) return;
        const originalCandidate = candidateFor(initial, worker, Date.now());
        if (!originalCandidate || hasUncertainChatGPTSend(environmentId, worker.id)) continue;

        const status = await inspectBrowserSession(environmentId, worker);
        // The host can report "unloaded" for a deferred guest. Its status
        // contract is being widened in another owned recovery change.
        const observedStatus: string = status.status;
        if (isPersistentChatGPTSessionOptedIn(worker.id)) {
          // A task completion alone cannot close an unknown native host; it
          // must have affirmative live idle and composer proof.
          if (!originalCandidate) continue;
          // Native browser owners cannot be inferred from preview snapshots.
          // Only close a genuinely idle, positively inspected exact owner.
          if (!["done_or_idle", "waiting_for_input"].includes(observedStatus) ||
              status.activity !== "idle" || !status.observedGuestUrl) continue;
          const bridge = window.desktopBridge?.stableChatGPTViewRequest;
          if (!bridge ||
              await nativeChatGPTResidency(bridge, environmentId, worker.id) !== "resident")
            continue;
          const currentSessions = readChatGPTBrowserSessions(environmentId);
          const current = currentSessions.find((entry) => entry.id === worker.id);
          if (unmounted() || !current || JSON.stringify(current) !== JSON.stringify(worker) ||
              !candidateFor(currentSessions, current, Date.now()) ||
              hasUncertainChatGPTSend(environmentId, worker.id))
            continue;
          try {
            await runChatGPTSessionControl({
              environmentId, sessions: currentSessions,
              sessionId: worker.id, action: "change_state", state: "closed",
              neverWake: true,
            });
            if (unmounted() ||
                hasUncertainChatGPTSend(environmentId, worker.id) ||
                JSON.stringify(readChatGPTBrowserSessions(environmentId).find(
                  (entry) => entry.id === worker.id,
                )) !== JSON.stringify(current)) continue;
            await bridge({ operation: "close", identity: {
              environmentId, sessionId: worker.id, profileId: chatGPTSessionProfileId(worker),
            } });
            if (selectedSessionId.current === worker.id) continue;
            removeSession(worker.id, "completed-worker");
            removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, worker.id));
            removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, worker.id));
            clearSpawnAutoCloseIdleSince(environmentId, worker.id);
            return;
          } catch (error) {
            console.warn("[ChatGPT completed-worker cleanup] Native close refused", worker.id, error);
          }
          continue;
        }
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
        const registeredId = worker.bootstrapIdentity?.state === "registered"
          ? worker.bootstrapIdentity.conversationId
          : null;

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

        // Inactive unmounted workers still need exact conversation identity.
        const inactiveUnloadedClose =
          observedStatus === "unavailable" &&
          status.statusReason === "Embedded ChatGPT webview is not mounted." &&
          noMountedGuest &&
          typeof registeredId === "string" &&
          !!chatGPTConversationIdFromUrl(`https://chatgpt.com/c/${registeredId}`) &&
          (conversationId === null || conversationId === registeredId) &&
          (snapshot === null || (
            preview.activeTabId === snapshot.tabId &&
            (snapshot.navStatus._tag !== "Success" ||
              chatGPTConversationIdFromUrl(snapshot.navStatus.url) === registeredId)
          ));
        const allowedColdClose = coldClose || inactiveUnloadedClose;
        const closeCandidate = originalCandidate;

        const liveClose =
          !!originalCandidate &&
          snapshot !== null &&
          (status.status === "done_or_idle" || status.status === "waiting_for_input") &&
          status.activity === "idle" &&
          status.uiColor !== "interrupted" &&
          !!status.observedGuestUrl;
        if (!liveClose && !allowedColdClose) continue;

        try {
          // Recheck role, inactivity clock, exemptions and session
          // identity after asynchronous host/UI operations. A sidebar click
          // does NOT make a session human-controlled.
          const currentSessions = readChatGPTBrowserSessions(environmentId);
          const current = currentSessions.find((entry) => entry.id === worker.id);
          if (
            unmounted() ||
            !current ||
            JSON.stringify(current) !== JSON.stringify(worker) ||
            !candidateFor(currentSessions, current, Date.now())
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

          if (allowedColdClose) {
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
            unmounted() ||
            hasUncertainChatGPTSend(environmentId, current.id) ||
            JSON.stringify(readChatGPTBrowserSessions(environmentId).find(
              (entry) => entry.id === current.id,
            )) !== JSON.stringify(current) ||
            (snapshot !== null
              ? latestPreview.sessions[snapshot.tabId] !== snapshot
              : Object.keys(latestPreview.sessions).length !== 0) ||
            (allowedColdClose &&
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
          if (selectedSessionId.current === current.id) continue;
          removeSession(current.id, "completed-worker");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, current.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, current.id));
          clearSpawnAutoCloseIdleSince(environmentId, current.id);
          console.info("[ChatGPT completed-worker cleanup]", {
            sessionId: current.id,
            taskIds: closeCandidate?.taskIds,
            dueAt: closeCandidate?.dueAt,
            reason: closeCandidate?.reason,
          });
          return;
        } catch (error) {
          console.warn("[ChatGPT completed-worker cleanup] Skipped unsafe close", worker.id, error);
        }
      }
    };
    void scan()
      .catch((error: unknown) => {
        console.warn("[ChatGPT worker cleanup] Unable to inspect inactive worker", error);
      })
      .finally(() => {
        scanning.current = false;
      });
  }, [environmentId, managerIds, now, close, removeSession]);
  return null;
}
