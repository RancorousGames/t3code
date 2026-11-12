import { useEffect, useRef } from "react";
import { isChatGPTSessionBeingViewed } from "../../browser/chatGPTViewingProtection";
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
  chatGPTGuestTouchedAt,
  clearChatGPTGuestUserOpened,
  evictVerifiedIdleChatGPTGuest,
} from "../../browser/chatGPTGuestHibernation";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { nativeChatGPTPageStatus } from "../../browser/nativeChatGPTWarmSession";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { activeOmniworkUnloadPolicy } from "../../omniwork/chatGPTUnloadPolicy";
import { useChatGPTWarmSessions } from "../../omniwork/chatGPTWarmSessionPolicy";
import { readThreadPreviewState } from "../../previewStateStore";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { inspectChatGPTPageSnapshot, type ChatGPTPageSnapshot } from "../../chatGPTPageSnapshot";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";
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

/** Explicit opens expire after the idle window instead of permanently bypassing
 * the soft cap. Snooze is a deliberate release; "Keep loaded" remains a pin. */
export function canEvictChatGPTOverflowSession(input: {
  readonly now: number;
  readonly lastUsedAt: number;
  readonly idleMs: number | null;
  readonly snoozedUntil?: number | undefined;
  readonly selected: boolean;
  readonly viewed: boolean;
  readonly keepLoaded: boolean;
  readonly caffySoon: boolean;
  readonly deliveryPending: boolean;
  readonly sendUncertain: boolean;
}): boolean {
  if (input.idleMs === null || input.selected || input.viewed || input.keepLoaded ||
    input.caffySoon || input.deliveryPending || input.sendUncertain) return false;
  return (input.snoozedUntil ?? 0) > input.now ||
    input.lastUsedAt <= input.now - input.idleMs;
}

/** The maximum is soft: evict only verified idle pages with an empty composer.
 * User selection, explicit pins, delivery, errors and unknown state stay protected. */
export function ChatGPTIdleOverflowUnloader({
  environmentId,
  sessions,
  selectedId,
  maxCount,
  deliveryRequests,
  imminentCaffyIds,
}: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
  selectedId: string | undefined;
  maxCount: number;
  deliveryRequests: Readonly<Record<string, boolean>>;
  imminentCaffyIds: ReadonlySet<string>;
}) {
  // Inputs change identity often (the Caffy poll alone produces a new
  // imminentCaffyIds Set every 10s). Read them through a ref so the timers
  // below are not torn down and restarted before they ever fire.
  const latest = useRef({ sessions, selectedId, maxCount, deliveryRequests, imminentCaffyIds });
  latest.current = { sessions, selectedId, maxCount, deliveryRequests, imminentCaffyIds };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes native/legacy guest capacity with actual Chromium residency.
  useEffect(() => {
    let disposed = false;
    let checking = false;
    const run = async () => {
      if (checking || disposed) return;
      checking = true;
      const { sessions, maxCount } = latest.current;
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
        if (disposed || (native.length > 0 && !bridge)) return;
        // One unavailable/mismatched probe must not prevent eviction of other
        // positively identified residents. Unknown pages are never closed.
        const residents = nativeStatus.filter(({ status }) => status.residency === "resident");
        const legacyKeys = new Set(
          Array.from(document.querySelectorAll<HTMLElement>(
            'webview[data-preview-tab], [data-t3-chromium-guest="true"][data-preview-tab]',
          ), (node) => node.dataset.previewTab ? chatGPTGuestKey(node.dataset.previewTab) : null)
            .filter((key): key is string => key !== null),
        );
        let overflow = residents.length + legacyKeys.size - maxCount;
        if (overflow <= 0) return;

        const idleMs = activeOmniworkUnloadPolicy().idleMs;
        // Reads the latest props, so re-checks after an await see current selection.
        const eligible = (session: BrowserSession) => {
          const { selectedId, deliveryRequests, imminentCaffyIds } = latest.current;
          const key = JSON.stringify([
            environmentId, chatGPTBrowserThreadRef(environmentId, session.id).threadId,
          ]);
          const lastUsedAt = Math.max(
            getLocalStorageItem(
              chatGPTBrowserLastWorkingKey(environmentId, session.id), Schema.Number,
            ) ?? 0,
            session.lastDirectInteractionAt ?? 0,
            chatGPTGuestTouchedAt(key) ?? 0,
          );
          return canEvictChatGPTOverflowSession({
            now: Date.now(),
            lastUsedAt,
            idleMs,
            snoozedUntil: session.snoozedUntil,
            selected: session.id === selectedId,
            viewed: isChatGPTSessionBeingViewed(environmentId, session.id),
            keepLoaded: useChatGPTWarmSessions.getState().keepLoadedIds.has(session.id),
            caffySoon: imminentCaffyIds.has(session.id),
            deliveryPending: deliveryRequests[`${environmentId}:${session.id}`] === true,
            sendUncertain: hasUncertainChatGPTSend(environmentId, session.id),
          });
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
            if (disposed || !eligible(session) ||
                isChatGPTSessionBeingViewed(environmentId, session.id)) continue;
            await bridge({ operation: "close", identity: nativeIdentity, automatic: true });
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
            if (disposed || !eligible(session) ||
                isChatGPTSessionBeingViewed(environmentId, session.id)) continue;
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
  }, [environmentId]);
  return null;
}
