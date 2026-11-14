import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { chatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import { isChatGPTHomeUrl } from "../../chatGPTBrowserPrewarm";
import {
  chatGPTBrowserLastUrlKey, chatGPTBrowserLastWorkingKey, chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions, useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { blankChatGPTSessionCandidate } from "../../chatGPTBlankSessionCleanupPolicy";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { hasVerifiedUnusedNewChatGuest } from "../../chatGPTDraftInspection";
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import { hasUncertainChatGPTSend, runChatGPTSessionControl } from "../../chatGPTSessionControl";
import { isChatGPTGuestHibernated, chatGPTGuestTouchedAt } from "../../browser/chatGPTGuestHibernation";
import { inspectPersistentChatGPTPage } from "../../browser/inspectPersistentChatGPTPage";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { readThreadPreviewState } from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";

/** Auto-retire only *provably pristine* ChatGPT homepages, never a stored URL or
 * an unmounted guest. A transient navigation and an unreadable composer fail closed. */
export function ChatGPTBlankSessionCleanup({
  environmentId, activeSessionId, managerIds, now,
}: {
  environmentId: EnvironmentId;
  activeSessionId: string | undefined;
  managerIds: ReadonlySet<string> | null;
  now: number;
}) {
  const { removeSession } = useChatGPTBrowserSessions(environmentId);
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const scanning = useRef(false);
  const lastScan = useRef(0);

  useEffect(() => {
    if (scanning.current || now - lastScan.current < 5_000 || managerIds === null) return;
    scanning.current = true;
    lastScan.current = now;
    let cancelled = false;
    const currentSelection = () =>
      /\/browser\/([^/?#]+)/.exec(window.location.pathname)?.[1] ?? activeSessionId;
    const scan = async () => {
      const sessions = readChatGPTBrowserSessions(environmentId);
      for (const session of sessions) {
        if (cancelled) return;
        const thread = chatGPTBrowserThreadRef(environmentId, session.id);
        const preview = readThreadPreviewState(thread);
        const tabId = preview.activeTabId;
        const snapshot = tabId ? preview.sessions[tabId] : undefined;
        const runtimeId = tabId && preview.serverEpoch
          ? previewRuntimeTabId(thread, preview.serverEpoch, tabId) : null;
        const native = isPersistentChatGPTSessionOptedIn(session.id);
        const candidate = () => blankChatGPTSessionCandidate({
          session, sessions: readChatGPTBrowserSessions(environmentId),
          selectedId: currentSelection(), managerIds,
          receipt: readChatGPTSpawnReceipts(environmentId).find((r) => r.sessionId === session.id),
          now: Date.now(),
          lastTouchedAt: runtimeId ? (chatGPTGuestTouchedAt(runtimeId) ?? 0) : 0,
          hasConversationUrl: chatGPTConversationIdFromUrl(getLocalStorageItem(
            chatGPTBrowserLastUrlKey(environmentId, session.id), Schema.String,
          )) !== null,
          hasPendingSend: hasUncertainChatGPTSend(environmentId, session.id),
        });
        if (!candidate()) continue;

        const bridge = window.desktopBridge?.stableChatGPTViewRequest;
        const identity = { environmentId, sessionId: session.id, profileId: chatGPTSessionProfileId(session) };
        const guest = runtimeId && !native
          ? Array.from(document.querySelectorAll("webview")).find(
            (element) => element.dataset.previewTab === runtimeId,
          ) : undefined;
        const provenBlank = async (): Promise<boolean> => {
          if (native) {
            if (!bridge) return false;
            const state = await bridge({ operation: "probe", identity }) as {
              residency?: string; destroyed?: boolean; loading?: boolean; url?: string;
            };
            if (state.residency !== "resident" || state.destroyed || state.loading ||
                !state.url || !isChatGPTHomeUrl(state.url)) return false;
            const adapter = { executeJavaScript: (expression: string) =>
              inspectPersistentChatGPTPage(environmentId, session.id, expression) };
            return (await inspectPersistentChatGPTPage<string>(
              environmentId, session.id, CHATGPT_ACTIVITY_EXPRESSION,
            )) === "idle" && await hasVerifiedUnusedNewChatGuest(adapter, state.url);
          }
          if (!snapshot || !runtimeId || !guest ||
              Object.keys(preview.sessions).length !== 1 ||
              snapshot.navStatus._tag !== "Success" ||
              !isChatGPTHomeUrl(snapshot.navStatus.url) ||
              preview.desktopByTabId[tabId!]?.loading !== false ||
              isChatGPTGuestHibernated(runtimeId) || !document.contains(guest)) return false;
          return (await guest.executeJavaScript(CHATGPT_ACTIVITY_EXPRESSION)) === "idle" &&
            await hasVerifiedUnusedNewChatGuest(guest, snapshot.navStatus.url);
        };
        try {
          if (!(await provenBlank()) || cancelled || !candidate()) continue;
          const latest = readChatGPTBrowserSessions(environmentId).find((s) => s.id === session.id);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(session)) continue;
          // The guarded close independently double-checks the composer and
          // rejects changed navigation or an UNKNOWN recipient send.
          await runChatGPTSessionControl({
            environmentId, sessions: readChatGPTBrowserSessions(environmentId),
            sessionId: session.id, action: "change_state", state: "closed", neverWake: true,
          });
          if (cancelled || !candidate() ||
              JSON.stringify(readChatGPTBrowserSessions(environmentId).find((s) => s.id === session.id)) !==
                JSON.stringify(session) || !(await provenBlank())) continue;

          if (native) {
            await bridge!({ operation: "close", identity });
          } else {
            const currentPreview = readThreadPreviewState(thread);
            if (!snapshot || currentPreview.sessions[tabId!] !== snapshot) continue;
            const closed = await closePreviewSession({
              closePreview, snapshot, tabId: tabId!, threadRef: thread,
            });
            if (closed._tag === "Failure") continue;
          }
          if (cancelled || currentSelection() === session.id ||
              hasUncertainChatGPTSend(environmentId, session.id)) continue;
          removeSession(session.id, "unused-empty-manual");
          removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, session.id));
          removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, session.id));
          console.info("[ChatGPT blank session cleanup]", {
            sessionId: session.id, task: session.binding?.taskRef ?? null,
            reason: "Unselected for 2+ minutes; live homepage and pristine composer verified twice",
          });
          return; // At most one closure per sweep.
        } catch (error) {
          console.warn("[ChatGPT blank session cleanup] Skipped uncertain close", session.id, error);
        }
      }
    };
    void scan().catch((error: unknown) => {
      console.warn("[ChatGPT blank session cleanup] Scan failed", error);
    }).finally(() => { scanning.current = false; });
    return () => { cancelled = true; };
  }, [activeSessionId, closePreview, environmentId, managerIds, now, removeSession]);
  return null;
}
