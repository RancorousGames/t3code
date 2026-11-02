import { useParams } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import {
  recentChatGPTGuestKeys,
  retainChatGPTGuests,
  touchChatGPTGuest,
  useChatGPTGuestHibernation,
} from "../../browser/chatGPTGuestHibernation";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserLastUrlKey,
  isChatGPTConversationUrl,
  chatGPTBrowserThreadRef,
  useChatGPTBrowserSessions,
  type BrowserSession,
} from "../../chatGPTBrowserSessions";
import { isElectron } from "../../env";
import { useOmniworkPreferences } from "../../omniwork/chatGPTUnloadPolicy";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { readChatGPTRecoveryState } from "../../chatGPTRecoveryDiagnostics";
import { useOpenRigManagerChatGPTSessions } from "./useOpenRigManagerChatGPTSessions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  useChatGPTDeliveryMountRequests,
  requestChatGPTDeliveryMount,
  releaseChatGPTDeliveryMount,
} from "../../chatGPTDeliveryMountRequest";
import { ChatGPTBrowserSessionRuntime } from "./ChatGPTBrowserSessionRuntime";
import {
  useChatGPTSessionQueue,
  useChatGPTSessionQueueDriver,
} from "../../chatGPTSessionMessageQueue";
import { ChatGPTWarmScheduler } from "./ChatGPTWarmScheduler";
import { useChatGPTBootstrapRegistration } from "../../browser/useChatGPTBootstrapRegistration";
import { ChatGPTRestartContinuation } from "./ChatGPTRestartContinuation";
import { getChatGPTStartupLoadPlan } from "../../omniwork/chatGPTStartupLoadPolicy";
import { chatGPTRestartWorkingSessions } from "../../omniwork/chatGPTRestartWorkingSessions";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";

/** Bootstrap identity belongs to the persistent session, not a transient
 * sidebar/preview runtime. Monitor native pages even while sidebar is absent. */
function ChatGPTBootstrapRegistrationOwner({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  useChatGPTBootstrapRegistration(environmentId, sessionId);
  return null;
}

const CachedManagerIds = Schema.Struct({
  observedAt: Schema.Number,
  ids: Schema.Array(Schema.String),
});
const managerCacheKey = (environmentId: string) =>
  `t3code:chatgpt-browser:verified-manager-retention:${environmentId}`;

function recoverableSession(environmentId: string, sessionId: string): boolean {
  const state = readChatGPTRecoveryState(environmentId, sessionId);
  return (
    state.orangeStage !== null ||
    state.retryCount > 0 ||
    state.nextRetryAt !== null ||
    state.escalationReason !== null
  );
}

/** Keep capacity-queued messages moving on any page, not just the sidebar.
 * T3 still performs all message delivery; this owner only requests an existing
 * targeted guest mount AFTER OpenRig has granted a slot. */
function ChatGPTBackgroundQueueOwner({ environmentId, sessionId, sessions }: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly sessions: readonly BrowserSession[];
}) {
  const queue = useChatGPTSessionQueue(environmentId, sessionId);
  useChatGPTSessionQueueDriver(environmentId, sessionId, sessions);
  const admitted = queue.some(row => row.condition === "wait_for_slot" &&
    !!row.capacityAdmittedAt && !row.capacityReleasedAt &&
    ["queued", "sending", "delivered"].includes(row.state));
  useEffect(() => {
    if (!admitted) return;
    requestChatGPTDeliveryMount(environmentId, sessionId);
    return () => releaseChatGPTDeliveryMount(environmentId, sessionId);
  }, [admitted, environmentId, sessionId]);
  return null;
}

/** Keep a small ordinary working set plus all proven important sessions. */
export function ChatGPTGuestRetention() {
  const environmentId = usePrimaryEnvironmentId();
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const deliveryRequests = useChatGPTDeliveryMountRequests((state) => state.required);
  const managerIds = useOpenRigManagerChatGPTSessions(environmentId);
  const activeSessionId = useParams({ strict: false, select: (params) => params.browserSessionId });
  const touchedAt = useChatGPTGuestHibernation((state) => state.touchedAt);
  const unloadProfile = useOmniworkPreferences((state) => state.unloadProfile);
  const recentGuests = useOmniworkPreferences((state) => state.recentGuests);
  const loadAllStartup = useOmniworkPreferences((state) => state.loadAllChatGPTSessionsOnStartup);
  // UNKNOWN send receipts are not delivered prompts. Restore only their exact
  // persisted conversation owners for inspection; never retry the composer.
  const uncertainOwners = useMemo(() => {
    if (!environmentId) return new Set<string>();
    return new Set(
      sessions
        .filter(
          (session) =>
            hasUncertainChatGPTSend(environmentId, session.id) &&
            isChatGPTConversationUrl(
              getLocalStorageItem(
                chatGPTBrowserLastUrlKey(environmentId, session.id),
                Schema.String,
              ),
            ),
        )
        .map((session) => session.id),
    );
  }, [environmentId, sessions]);
  // Register the selected restored session before child runtimes decide to open.
  if (isElectron && environmentId && sessions.length > 0) {
    const plan = getChatGPTStartupLoadPlan(
      environmentId,
      sessions.map((session) => session.id),
      loadAllStartup,
    );
    if (activeSessionId) plan.activatedIds.add(activeSessionId);
    for (const id of uncertainOwners) plan.activatedIds.add(id);
    // A previously streaming response gets its exact guest remounted once.
    // This never sends Continue, nor bypasses UNKNOWN-send or snooze.
    for (const id of chatGPTRestartWorkingSessions(
      sessions, getChatGPTSessionPersistedStore(environmentId).getState().snapshots,
      Date.now(), uncertainOwners,
    )) plan.activatedIds.add(id);
  }
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!isElectron || !environmentId || !activeSessionId) return;
    const thread = chatGPTBrowserThreadRef(environmentId, activeSessionId);
    touchChatGPTGuest(JSON.stringify([environmentId, thread.threadId]));
  }, [environmentId, activeSessionId]);

  useEffect(() => {
    if (!isElectron) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isElectron || !environmentId || managerIds === null) return;
    try {
      setLocalStorageItem(
        managerCacheKey(environmentId),
        { observedAt: Date.now(), ids: [...managerIds] },
        CachedManagerIds,
      );
    } catch {
      // Retention also uses live seat evidence and structural parent links.
    }
  }, [environmentId, managerIds]);

  const retainedKeys = useMemo(() => {
    if (!isElectron || !environmentId) return [];
    let protectedManagers = managerIds;
    if (protectedManagers === null) {
      try {
        const saved = getLocalStorageItem(managerCacheKey(environmentId), CachedManagerIds);
        // Verified manager attribution survives temporary Rig outages. A later
        // authoritative seat snapshot, not elapsed idle time, revokes it.
        if (saved && saved.observedAt > 0 && saved.observedAt <= now)
          protectedManagers = new Set(saved.ids);
      } catch {
        // A corrupt cache is not authoritative.
      }
    }
    const parents = new Set(
      sessions.map((session) => session.parentSessionId).filter((id): id is string => !!id),
    );
    const protectedKeys = new Set<string>();
    const candidates = sessions.flatMap((session) => {
      const thread = chatGPTBrowserThreadRef(environmentId, session.id);
      const key = JSON.stringify([environmentId, thread.threadId]);
      const recentUseAt = Math.max(
        touchedAt[key] ?? 0,
        session.lastDirectInteractionAt ?? 0,
        getLocalStorageItem(
          chatGPTBrowserLastWorkingKey(environmentId, session.id),
          Schema.Number,
        ) ?? 0,
      );
      const longIdle =
        session.humanControlled === true ||
        (!session.markedAsWorkerAt &&
          (protectedManagers?.has(session.id) === true ||
            parents.has(session.id) ||
            !session.parentSessionId));
      const withinLongIdle = recentUseAt > now - 4 * 60 * 60_000;
      const important =
        deliveryRequests[`${environmentId}:${session.id}`] === true ||
        activeSessionId === session.id ||
        (!!session.borderColor && (!longIdle || withinLongIdle)) ||
        (longIdle && withinLongIdle) ||
        hasUncertainChatGPTSend(environmentId, session.id) ||
        recoverableSession(environmentId, session.id) ||
        (!longIdle && recentUseAt > now - 60_000);
      if (important) protectedKeys.add(key);
      if (longIdle && !withinLongIdle && !important && unloadProfile !== "never") return [];
      // Hidden/snoozed ordinary sessions can be unloaded, but neither state
      // revokes manager, active, UNKNOWN-send or recovery protection.
      if (
        unloadProfile !== "never" &&
        !important &&
        (session.hidden || (session.snoozedUntil && session.snoozedUntil > now))
      )
        return [];
      return [
        {
          key,
          lastUsedAt: Math.max(
            touchedAt[key] ?? 0,
            getLocalStorageItem(
              chatGPTBrowserLastWorkingKey(environmentId, session.id),
              Schema.Number,
            ) ?? 0,
          ),
        },
      ];
    });
    return recentChatGPTGuestKeys(candidates, protectedKeys);
  }, [
    activeSessionId,
    environmentId,
    managerIds,
    sessions,
    touchedAt,
    now,
    unloadProfile,
    recentGuests,
    deliveryRequests,
  ]);

  useEffect(() => retainChatGPTGuests(retainedKeys), [retainedKeys]);
  // This owner stays mounted on Settings and when the sidebar is collapsed.
  return isElectron && environmentId ? (
    <>
      {sessions.map((session) => (
        <ChatGPTBootstrapRegistrationOwner
          key={session.id}
          environmentId={environmentId}
          sessionId={session.id}
        />
      ))}
      <ChatGPTWarmScheduler />
      <ChatGPTRestartContinuation environmentId={environmentId} />
      {sessions.filter(session => !session.hidden).map(session => (
        <ChatGPTBackgroundQueueOwner key={`queue:${session.id}`}
          environmentId={environmentId} sessionId={session.id} sessions={sessions} />
      ))}
      {sessions
        .filter(
          (session) =>
            deliveryRequests[`${environmentId}:${session.id}`] || uncertainOwners.has(session.id),
        )
        .map((session) => (
          <ChatGPTBrowserSessionRuntime
            key={session.id}
            environmentId={environmentId}
            sessionId={session.id}
            suspended={false}
            quiet
          />
        ))}
    </>
  ) : null;
}
