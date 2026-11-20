import { useEffect, useMemo, useRef } from "react";
import { visibleSplitSessionIds } from "../../chatGPTSplitLayout";
import { useAttentionPrioritySessionIds } from "../../chatGPTAttentionPriority";
import { inspectBrowserSession } from "../../chatGPTSessionControl";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { isElectron } from "../../env";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  isChatGPTGuestHibernated,
  isChatGPTGuestManuallyUnloaded,
  useChatGPTGuestHibernation,
  wakeChatGPTGuest,
} from "../../browser/chatGPTGuestHibernation";
import { MOUNTED_CHATGPT_GUEST_SELECTOR } from "../../browser/mountedChatGPTGuest";
import {
  beginChatGPTRecoveryTimeline,
  logChatGPTRecoveryAttempt,
  logChatGPTRecoveryHealth,
  logChatGPTRecoveryPriority,
  logChatGPTRecoveryTimeline,
} from "../../chatGPTRecoveryTimeline";
import { useOmniworkPreferences } from "../../omniwork/chatGPTUnloadPolicy";
import { useChatGPTRecoverySettings } from "../../chatGPTRecoverySettings";
import { getChatGPTStartupLoadPlan } from "../../omniwork/chatGPTStartupLoadPolicy";
import {
  warmRecentClickRanks,
  wasWarmSessionActiveBeforeFailure,
} from "../../omniwork/chatGPTWarmPriorityHistory";
import { resolveWarmChatGPTConversationUrl } from "../../omniwork/chatGPTWarmConversationUrl";
import { readThreadPreviewState } from "../../previewStateStore";
import { snapshotWarmSessionOccupancy } from "../../omniwork/chatGPTWarmOccupancy";
import {
  activateWarmChatGPTSession,
  finishWarmChatGPTSessionLoad,
  nextWarmChatGPTSession,
  plannedWarmChatGPTSessions,
  publishWarmChatGPTForecast,
  useChatGPTWarmSessions,
} from "../../omniwork/chatGPTWarmSessionPolicy";
import { useOpenRigManagerChatGPTSessions } from "./useOpenRigManagerChatGPTSessions";

const warmPriorityReason = (
  c: {
    selected: boolean;
    activeBeforeFailure: boolean;
    recoveryQueued?: boolean;
    deliveryPending?: boolean;
    keepLoaded?: boolean;
    returnMarked?: boolean;
    caffyDueSoon?: boolean;
    recentlyClicked: number;
    highlighted: boolean;
    lastActiveAt: number;
    manager: boolean;
    lastActivityAt: number;
  },
  now: number,
) =>
  c.selected
    ? "selected by user"
    : c.deliveryPending
      ? "pending message delivery"
      : c.returnMarked
        ? "Mark attention / GMA"
        : c.keepLoaded
          ? "kept loaded by user"
          : c.caffyDueSoon
            ? "Caffy wake due within 30 minutes"
            : c.recoveryQueued
              ? "verified recovery waiting for resident browser"
              : c.activeBeforeFailure
                ? "working before failure"
                : c.recentlyClicked >= 0
                  ? "recent click #" + (c.recentlyClicked + 1)
                  : c.highlighted
                    ? "highlighted"
                    : c.lastActiveAt >= now - 2 * 60 * 60_000 && c.lastActiveAt > 0
                      ? "active within 2 hours"
                      : c.manager
                        ? "manager"
                        : c.lastActivityAt > 0
                          ? "recent activity"
                          : "creation time";

/**
 * Captures restored guests before the sidebar mounts them, then gradually warms
 * an additive working set. Only attached webviews and in-flight requests occupy
 * warm slots; merely being eligible to mount is not physical residency.
 */
export function ChatGPTWarmScheduler({
  imminentCaffyIds,
}: {
  readonly imminentCaffyIds: ReadonlySet<string>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const selectedId = useParams({ strict: false, select: (params) => params.browserSessionId });
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const attentionPriorityIds = useAttentionPrioritySessionIds(sessions);
  const managers = useOpenRigManagerChatGPTSessions(environmentId);
  const keepLoadedIds = useChatGPTWarmSessions((state) => state.keepLoadedIds);
  const warmCount = useOmniworkPreferences((state) => state.chatGPTWarmSessionCount);
  // Shared manual override: pause auto recovery and auto warming together.
  const autoMaintenancePaused = useChatGPTRecoverySettings().paused;
  const loadAllStartup = useOmniworkPreferences((state) => state.loadAllChatGPTSessionsOnStartup);
  // These survive ordinary session-list/sidebar updates, which re-run the effect.
  const lastStartedAt = useRef(0);
  const pendingGuestIds = useRef(new Map<string, string>());
  const recipientMountReports = useRef(new Set<string>());
  const retryAfter = useRef(new Map<string, number>()).current;
  const plan = useMemo(() => {
    if (!isElectron || !environmentId || sessions.length === 0) return null;
    return getChatGPTStartupLoadPlan(
      environmentId,
      sessions.map((session) => session.id),
      loadAllStartup && warmCount >= sessions.length,
    );
  }, [environmentId, sessions, loadAllStartup, warmCount]);

  useEffect(() => {
    if (!isElectron || !environmentId || !plan) {
      if (environmentId) publishWarmChatGPTForecast(environmentId, []);
      return;
    }
    beginChatGPTRecoveryTimeline(
      environmentId,
      "all",
      `Warm scheduler initialized: ${sessions.length} sessions, target ${warmCount}, load-all-restored=${loadAllStartup}, selected=${selectedId ?? "none"}, paused=${autoMaintenancePaused}.`,
    );
    if (autoMaintenancePaused) {
      publishWarmChatGPTForecast(environmentId, []);
      logChatGPTRecoveryPriority(
        environmentId,
        "all",
        [],
        [],
        autoMaintenancePaused
          ? "Automatic loading/recovery paused in settings."
          : "Warm capacity is zero; no automatic loading.",
        "paused",
      );
      return;
    }
    let loggedMissingUrls = false;
    let deliverySnapshotRunning = false;
    const inspectDeliveryQueue = async () => {
      if (deliverySnapshotRunning) return;
      const read = window.desktopBridge?.readChatGPTDeliveryDiagnostics;
      if (!read) return;
      deliverySnapshotRunning = true;
      try {
        const diagnostics = await read();
        const waiting = new Map<string, string>();
        for (const message of diagnostics.messages) {
          if (message.status === "queued" && message.reason === "guest_unmounted") {
            waiting.set(message.sessionId, message.conversationId);
          }
        }
        pendingGuestIds.current = waiting;
        for (const id of recipientMountReports.current)
          if (!waiting.has(id)) recipientMountReports.current.delete(id);
      } catch {
        /* Keep last known priorities until bridge is available. */
      } finally {
        deliverySnapshotRunning = false;
      }
    };
    const reportLoadedRecipient = async (session: (typeof sessions)[number]) => {
      const expected = pendingGuestIds.current.get(session.id);
      const forward = window.desktopBridge?.appActivation?.reportChatGPTRecipientMounted;
      if (!expected || !forward || recipientMountReports.current.has(session.id)) return;
      // An attached webview alone isn't sufficient. Confirm the exact ChatGPT
      // conversation and an input-ready composer before releasing.
      try {
        const inspection = await inspectBrowserSession(environmentId, session, "end", 1, false);
        // A stopped/partial assistant turn leaves a user-only transcript.
        // It is still a valid mounted, idle composer: requiring a completed
        // assistant reply here deadlocks the durable Caffy wake indefinitely.
        // The final send independently checks draft, generation and identity.
        if (
          chatGPTConversationIdFromUrl(inspection.observedGuestUrl) !== expected ||
          inspection.activity !== "idle" ||
          !["done_or_idle", "waiting_for_input", "pending_or_stalled"].includes(inspection.status)
        )
          return;
        recipientMountReports.current.add(session.id);
        const released = await forward({ sessionId: session.id, conversationId: expected });
        if (!released) recipientMountReports.current.delete(session.id);
      } catch {
        /* Retry the observation on another scheduler tick. */
      }
    };
    let disposed = false;
    const retryKey = (id: string) => JSON.stringify([environmentId, id]);
    const tick = () => {
      const now = Date.now();
      void inspectDeliveryQueue();
      const loadingAt = useChatGPTWarmSessions.getState().loadingAt;
      const mountedRuntimeTabIds = Array.from(
        document.querySelectorAll<HTMLElement>(MOUNTED_CHATGPT_GUEST_SELECTOR),
        (element) => element.dataset.previewTab,
      ).filter((id): id is string => typeof id === "string" && id.length > 0);
      let eligible = sessions.filter((session) => {
        const deliveryPending = pendingGuestIds.current.has(session.id);
        const caffySoon = imminentCaffyIds.has(session.id);
        if (
          (session.hidden && !session.returnMarker && !keepLoadedIds.has(session.id)) ||
          (!session.returnMarker &&
            !deliveryPending &&
            !keepLoadedIds.has(session.id) &&
            session.snoozedUntil &&
            session.snoozedUntil > now) ||
          (!deliveryPending && (retryAfter.get(retryKey(session.id)) ?? 0) > now)
        )
          return false;
        const thread = chatGPTBrowserThreadRef(environmentId, session.id);
        const unloadKey = JSON.stringify([environmentId, thread.threadId]);
        // A new GMA request may requeue an automatically evicted guest, but
        // must not silently undo an explicit manual Unload or Snooze.
        const explicitUnload = isChatGPTGuestManuallyUnloaded(unloadKey);
        const autoEvicted = useChatGPTGuestHibernation.getState().autoEvicted?.[unloadKey];
        const urgent =
          Boolean(session.returnMarker) ||
          deliveryPending ||
          caffySoon ||
          keepLoadedIds.has(session.id);
        if (
          (explicitUnload && !urgent) ||
          (autoEvicted && !urgent && !attentionPriorityIds.has(session.id))
        )
          return false;
        let savedUrl: string | null = null;
        try {
          savedUrl = getLocalStorageItem(
            chatGPTBrowserLastUrlKey(environmentId, session.id),
            Schema.String,
          );
        } catch {
          // Corrupt local storage must not stop the rest of the warm queue.
        }
        const nav = readThreadPreviewState(thread).snapshot?.navStatus;
        const previewUrl = nav?._tag === "Success" ? nav.url : null;
        return resolveWarmChatGPTConversationUrl(session, savedUrl, previewUrl) !== null;
      });
      if (!loggedMissingUrls && eligible.length === 0 && sessions.length > 0) {
        console.warn("[T3 warm] No eligible saved conversations; check stored conversation URLs.");
        loggedMissingUrls = true;
      } else if (eligible.length > 0) {
        loggedMissingUrls = false;
      }
      const snapshot = snapshotWarmSessionOccupancy({
        environmentId,
        now,
        mountedRuntimeTabIds,
        loadingAt,
        sessions: sessions.map((session) => {
          const threadId = chatGPTBrowserThreadRef(environmentId, session.id).threadId;
          return {
            id: session.id,
            threadId,
            mountEligible: true,
            hibernated: isChatGPTGuestHibernated(JSON.stringify([environmentId, threadId])),
          };
        }),
      });
      for (const session of sessions) {
        const key = JSON.stringify([environmentId, session.id]);
        const startedAt = loadingAt[key];
        if (!startedAt) continue;
        if (snapshot.mountedIds.has(session.id)) {
          retryAfter.delete(retryKey(session.id));
          finishWarmChatGPTSessionLoad(environmentId, session.id);
          logChatGPTRecoveryHealth(
            environmentId,
            "webview",
            session.id,
            "guest-attached",
            "Electron webview attached; ChatGPT composer health is checked separately.",
          );
        } else if (now - startedAt >= 45_000) {
          // A stuck guest must not monopolize every subsequent warm slot.
          retryAfter.set(retryKey(session.id), now + 90_000);
          finishWarmChatGPTSessionLoad(environmentId, session.id);
          logChatGPTRecoveryTimeline(
            environmentId,
            "webview",
            "retry",
            "ChatGPT webview did not attach within 45s; delayed for 90s before another warm attempt.",
            { sessionId: session.id, nextAt: now + 90_000 },
          );
          console.warn(
            "[T3 warm] Guest did not attach; continuing with the next session:",
            session.id,
          );
        }
      }
      // Publish only the true scheduler selection order, not every unloaded tab.
      // In-flight guests block the 12 s cadence; 45 s is the bounded attach window.
      const clickRanks = warmRecentClickRanks(environmentId, selectedId ?? null);
      const candidates = eligible.map((session) => {
        const lastActiveAt =
          getLocalStorageItem(
            chatGPTBrowserLastWorkingKey(environmentId, session.id),
            Schema.Number,
          ) ?? 0;
        return {
          id: session.id,
          selected:
            session.id === selectedId ||
            (selectedId !== undefined && visibleSplitSessionIds(environmentId).has(session.id)),
          deliveryPending: pendingGuestIds.current.has(session.id),
          keepLoaded: keepLoadedIds.has(session.id),
          caffyDueSoon: imminentCaffyIds.has(session.id),
          exceedTarget:
            pendingGuestIds.current.has(session.id) ||
            imminentCaffyIds.has(session.id) ||
            Boolean(session.returnMarker),
          returnMarked: Boolean(session.returnMarker),
          activeBeforeFailure: wasWarmSessionActiveBeforeFailure(environmentId, session.id),
          recentlyClicked: clickRanks.get(session.id) ?? -1,
          highlighted: Boolean(session.borderColor),
          manager: managers?.has(session.id) === true,
          lastActiveAt,
          lastActivityAt: Math.max(lastActiveAt, session.lastDirectInteractionAt ?? 0),
          createdAt: session.createdAt ?? 0,
        };
      });
      for (const session of eligible) {
        if (snapshot.mountedIds.has(session.id) && pendingGuestIds.current.has(session.id))
          void reportLoadedRecipient(session);
      }
      const selection = {
        candidates,
        loadedIds: snapshot.occupiedIds,
        targetCount: warmCount,
        now,
      };
      const planned = plannedWarmChatGPTSessions(selection);
      const fullPriority = plannedWarmChatGPTSessions({
        ...selection,
        targetCount: snapshot.occupiedIds.size + candidates.length + 1,
      });
      const activeLoading = Object.entries(useChatGPTWarmSessions.getState().loadingAt).filter(
        ([key, startedAt]) =>
          key.startsWith(JSON.stringify([environmentId]).slice(0, -1) + ",") &&
          now - startedAt < 45_000,
      );
      const firstAt = Math.max(
        now,
        lastStartedAt.current + 12_000,
        ...activeLoading.map(([, startedAt]) => startedAt + 45_000),
      );
      logChatGPTRecoveryPriority(
        environmentId,
        "webview",
        fullPriority.map((id) => ({
          id,
          reason: warmPriorityReason(
            candidates.find((c) => c.id === id)!,
            now,
          ),
        })),
        planned,
        `ChatGPT webviews: ${snapshot.occupiedIds.size} occupied, ${candidates.length} candidates.`,
        "warm",
        planned.map((id, ordinal) => ({ id, earliestAt: firstAt + ordinal * 12_000 })),
      );
      publishWarmChatGPTForecast(
        environmentId,
        planned.map((id, ordinal) => ({
          id,
          ordinal,
          notBefore: firstAt + ordinal * 12_000,
        })),
      );
      // Never overlap page loads or rotate healthy loaded guests.
      const environmentPrefix = JSON.stringify([environmentId]).slice(0, -1) + ",";
      if (
        Object.entries(useChatGPTWarmSessions.getState().loadingAt).some(
          ([key, startedAt]) => key.startsWith(environmentPrefix) && now - startedAt < 45_000,
        ) ||
        now - lastStartedAt.current < 12_000
      )
        return;
      const next = nextWarmChatGPTSession(selection);
      if (!next) return;
      const threadId = chatGPTBrowserThreadRef(environmentId, next).threadId;
      wakeChatGPTGuest(JSON.stringify([environmentId, threadId]));
      activateWarmChatGPTSession(environmentId, plan, next);
      logChatGPTRecoveryAttempt(
        environmentId,
        "webview",
        next,
        "Requested ChatGPT webview warm load; attachment window is 45s.",
      );
      lastStartedAt.current = now;
    };
    const initial = setTimeout(tick, 2500);
    const interval = setInterval(tick, 12_000);
    return () => {
      disposed = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [
    environmentId,
    selectedId,
    sessions,
    managers,
    plan,
    warmCount,
    autoMaintenancePaused,
    imminentCaffyIds,
    keepLoadedIds,
    attentionPriorityIds,
  ]);
  return null;
}
