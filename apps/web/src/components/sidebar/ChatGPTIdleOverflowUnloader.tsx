import { useEffect } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { readChatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import type { BrowserSession } from "../../chatGPTBrowserSessions";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
} from "../../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import {
  chatGPTGuestKey,
  clearChatGPTGuestUserOpened,
  evictVerifiedIdleChatGPTGuest,
} from "../../browser/chatGPTGuestHibernation";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { nativeChatGPTPageStatus } from "../../browser/nativeChatGPTWarmSession";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { readThreadPreviewState } from "../../previewStateStore";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { inspectChatGPTPageSnapshot, type ChatGPTPageSnapshot } from "../../chatGPTPageSnapshot";
import { CHATGPT_ACTIVITY_EXPRESSION, CHATGPT_RECENT_ACTIVITY_MS } from "./chatGPTActivity";
import * as Schema from "effect/Schema";

const SAFE_IDLE_EXPRESSION = `(() => {
  const activity = ${CHATGPT_ACTIVITY_EXPRESSION};
  return {
    activity,
    snapshot: (${inspectChatGPTPageSnapshot.toString()})(String(activity ?? "unknown")),
  };
})()`;

type Observed = { activity?: string; snapshot?: ChatGPTPageSnapshot | null };
export function safeToUnload(
  observation: Observed | null,
  expectedUrl: string | null,
): boolean {
  const page = observation?.snapshot;
  if (observation?.activity !== "idle" || page?.activity !== "idle" ||
      !page.signals.composerPresent || page.signals.draftPresent ||
      page.signals.stopButton || page.signals.interruptedBanner ||
      page.signals.signInOrCaptcha || page.signals.loadError ||
      !expectedUrl || page.url !== expectedUrl ||
      page.conversationId !== chatGPTConversationIdFromUrl(expectedUrl))
    return false;
  return true;
}

/** The maximum is soft: only an older, verified grey/idle page may be evicted.
 * User selection, delivery, errors and unknown state never become an eviction hint. */
export function ChatGPTIdleOverflowUnloader({
  environmentId,
  sessions,
  selectedId,
  maxCount,
  deliveryRequests,
}: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
  selectedId: string | undefined;
  maxCount: number;
  deliveryRequests: Readonly<Record<string, boolean>>;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes native/legacy guest capacity with actual Chromium residency.
  useEffect(() => {
    let disposed = false;
    let checking = false;
    const run = async () => {
      if (checking || disposed) return;
      checking = true;
      try {
        const bridge = window.desktopBridge?.stableChatGPTViewRequest;
        const native = sessions.filter((session) =>
          isPersistentChatGPTSessionOptedIn(session.id));
        const nativeStatus = bridge
          ? await Promise.all(native.map(async (session) => ({
              session,
              status: await nativeChatGPTPageStatus(bridge, environmentId, session.id),
            })))
          : [];
        if (disposed || (native.length > 0 && (!bridge ||
          nativeStatus.some(({ status }) => status.residency === "unknown")))) return;
        const residents = nativeStatus.filter(({ status }) => status.residency === "resident");
        const legacyKeys = new Set(
          Array.from(document.querySelectorAll<HTMLElement>(
            'webview[data-preview-tab], [data-t3-chromium-guest="true"][data-preview-tab]',
          ), (node) => node.dataset.previewTab ? chatGPTGuestKey(node.dataset.previewTab) : null)
            .filter((key): key is string => key !== null),
        );
        let overflow = residents.length + legacyKeys.size - maxCount;
        if (overflow <= 0) return;

        const now = Date.now();
        const eligible = (session: BrowserSession) => {
          const lastWorking = getLocalStorageItem(
            chatGPTBrowserLastWorkingKey(environmentId, session.id), Schema.Number,
          ) ?? 0;
          return session.id !== selectedId &&
            !deliveryRequests[`${environmentId}:${session.id}`] &&
            !hasUncertainChatGPTSend(environmentId, session.id) &&
            (session.snoozedUntil ?? 0) <= now &&
            (lastWorking <= 0 || lastWorking <= now - CHATGPT_RECENT_ACTIVITY_MS) &&
            (session.lastDirectInteractionAt ?? 0) <= now - 30_000;
        };
        const oldestFirst = [...sessions].filter(eligible).sort((a, b) =>
          (a.lastDirectInteractionAt ?? 0) - (b.lastDirectInteractionAt ?? 0));
        for (const session of oldestFirst) {
          if (disposed || overflow <= 0) break;
          if (isPersistentChatGPTSessionOptedIn(session.id)) {
            if (!bridge || !residents.some((row) => row.session.id === session.id)) continue;
            const nativeIdentity = {
              environmentId, sessionId: session.id,
              profileId: readChatGPTSessionProfileId(environmentId, session.id),
            };
            const probe = await bridge({ operation: "probe", identity: nativeIdentity }) as {
              residency?: string; url?: string; loading?: boolean; destroyed?: boolean;
            };
            if (probe.residency !== "resident" || probe.loading || probe.destroyed || !probe.url)
              continue;
            const evaluated = await bridge({
              operation: "evaluate", identity: nativeIdentity,
              expression: SAFE_IDLE_EXPRESSION,
            }) as { result?: Observed };
            if (!safeToUnload(evaluated.result ?? null, probe.url)) continue;
            // Do not use an earlier React selection snapshot if the route changed.
            if (disposed || window.location.pathname.endsWith(`/${session.id}`)) continue;
            await bridge({ operation: "close", identity: nativeIdentity });
            clearChatGPTGuestUserOpened(session.id);
            clearChatGPTGuestUserOpened(JSON.stringify([
              environmentId, chatGPTBrowserThreadRef(environmentId, session.id).threadId,
            ]));
            overflow--;
          } else {
            const stableKey = JSON.stringify([
              environmentId, chatGPTBrowserThreadRef(environmentId, session.id).threadId,
            ]);
            if (!legacyKeys.has(stableKey)) continue;
            const element = Array.from(document.querySelectorAll<
              HTMLElement & { executeJavaScript?: (script: string) => Promise<unknown> }
            >('webview[data-preview-tab], [data-t3-chromium-guest="true"][data-preview-tab]'))
              .find((node) => chatGPTGuestKey(node.dataset.previewTab ?? "") === stableKey);
            if (!element?.executeJavaScript) continue;
            const observation = await element.executeJavaScript(SAFE_IDLE_EXPRESSION) as Observed;
            const preview = readThreadPreviewState(
              chatGPTBrowserThreadRef(environmentId, session.id),
            );
            const nav = preview.activeTabId
              ? preview.sessions[preview.activeTabId]?.navStatus
              : null;
            const expectedUrl = nav?._tag === "Success" ? nav.url : null;
            if (!safeToUnload(observation, expectedUrl)) continue;
            if (disposed || window.location.pathname.endsWith(`/${session.id}`)) continue;
            evictVerifiedIdleChatGPTGuest(stableKey);
            overflow--;
          }
        }
      } catch (error) {
        console.warn("[T3 warm] Idle overflow inspection unavailable:", error);
      } finally {
        checking = false;
      }
    };
    const initial = setTimeout(() => void run(), 10_000);
    const timer = setInterval(() => void run(), 30_000);
    return () => {
      disposed = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [environmentId, sessions, selectedId, maxCount, deliveryRequests]);
  return null;
}
