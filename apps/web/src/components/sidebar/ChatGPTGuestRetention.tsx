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
  CHATGPT_DEFAULT_URL,
  readChatGPTBrowserSessions,
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
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { warmMissingNativeChatGPT } from "../../browser/nativeChatGPTWarmSession";
import { resolveWarmChatGPTConversationUrl } from "../../omniwork/chatGPTWarmConversationUrl";
import {
  useChatGPTSessionQueue,
  useChatGPTSessionQueueDriver,
} from "../../chatGPTSessionMessageQueue";
import { ChatGPTWarmScheduler } from "./ChatGPTWarmScheduler";
import { ChatGPTIdleOverflowUnloader } from "./ChatGPTIdleOverflowUnloader";
import { useChatGPTBootstrapRegistration } from "../../browser/useChatGPTBootstrapRegistration";
import { ChatGPTRestartContinuation } from "./ChatGPTRestartContinuation";
import { getChatGPTStartupLoadPlan } from "../../omniwork/chatGPTStartupLoadPolicy";
import { chatGPTRestartWorkingSessions } from "../../omniwork/chatGPTRestartWorkingSessions";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { useWarmChatGPTSessionIds } from "../../omniwork/chatGPTWarmSessionPolicy";

/** Bootstrap identity belongs to the persistent session, not a transient
 * sidebar/preview runtime. Keep monitoring native Chrome pages even when the
 * sidebar, tab or background warm guest isn't mounted in React. */
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

/** Queued instructions must remain driven on Settings/other pages where the
 * regular sidebar does not mount any session runtime. Admission is read-only
 * until OpenRig grants a slot; only then do we mount the exact guest. */
function ChatGPTBackgroundQueueOwner({
  environmentId,
  sessionId,
  sessions,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly sessions: readonly BrowserSession[];
}) {
  const queue = useChatGPTSessionQueue(environmentId, sessionId);
  useChatGPTSessionQueueDriver(environmentId, sessionId, sessions);
  const admitted = queue.some(
    (row) =>
      row.condition === "wait_for_slot" &&
      !!row.capacityAdmittedAt &&
      !row.capacityReleasedAt &&
      ["queued", "sending", "delivered"].includes(row.state),
  );
  useEffect(() => {
    if (!admitted) return;
    // Reuse the one targeted delivery mount owner. This avoids two independent
    // preview runtimes opening the same guest when the sidebar is also visible.
    requestChatGPTDeliveryMount(environmentId, sessionId);
    // Native Chromium owns its page independently of legacy preview tabs.
    // A capacity-admitted blank session must acquire its exact native owner
    // before the queued instruction can inspect the empty composer.
    if (isPersistentChatGPTSessionOptedIn(sessionId)) {
      const bridge = window.desktopBridge?.stableChatGPTViewRequest;
      if (bridge) {
        const current = readChatGPTBrowserSessions(environmentId).find(
          (row) => row.id === sessionId,
        );
        const savedUrl = getLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, sessionId),
          Schema.String,
        );
        const url = current ? resolveWarmChatGPTConversationUrl(current, savedUrl) : null;
        void warmMissingNativeChatGPT(
          bridge,
          environmentId,
          sessionId,
          url ?? CHATGPT_DEFAULT_URL,
        ).catch(() => {
          /* Keep the reservation and retry on the next genuine mount. */
        });
      }
    }
    return () => releaseChatGPTDeliveryMount(environmentId, sessionId);
  }, [admitted, environmentId, sessionId]);
  return null;
}

/** Retain a bounded automatic working set; explicit selection/delivery can mount on demand. */
export function ChatGPTGuestRetention({
  sidebarRuntimesAvailable = true,
}: {
  readonly sidebarRuntimesAvailable?: boolean;
} = {}) {
  const environmentId = usePrimaryEnvironmentId();
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const deliveryRequests = useChatGPTDeliveryMountRequests((state) => state.required);
  const managerIds = useOpenRigManagerChatGPTSessions(environmentId);
  const activeSessionId = useParams({ strict: false, select: (params) => params.browserSessionId });
  const touchedAt = useChatGPTGuestHibernation((state) => state.touchedAt);
  const manuallyUnloaded = useChatGPTGuestHibernation((state) => state.manuallyUnloaded);
  const autoEvicted = useChatGPTGuestHibernation((state) => state.autoEvicted);
  const userOpened = useChatGPTGuestHibernation((state) => state.userOpened);
  const warmedIds = useWarmChatGPTSessionIds(environmentId);
  const unloadProfile = useOmniworkPreferences((state) => state.unloadProfile);
  const recentGuests = useOmniworkPreferences((state) => state.recentGuests);
  const warmCount = useOmniworkPreferences((state) => state.chatGPTWarmSessionCount);
  const maxAutoCount = useOmniworkPreferences((state) => state.chatGPTMaxAutoSessionCount);
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
  const restartWorkingOwners = environmentId
    ? chatGPTRestartWorkingSessions(
        sessions,
        getChatGPTSessionPersistedStore(environmentId).getState().snapshots,
        Date.now(),
        uncertainOwners,
      )
    : new Set<string>();
  // Register the selected restored session before child runtimes decide to open.
  if (isElectron && environmentId && sessions.length > 0) {
    const plan = getChatGPTStartupLoadPlan(
      environmentId,
      sessions.map((session) => session.id),
      loadAllStartup && warmCount >= sessions.length,
    );
    if (activeSessionId) plan.activatedIds.add(activeSessionId);
    for (const id of uncertainOwners) plan.activatedIds.add(id);
    // A previously streaming response gets its exact guest remounted once.
    // This never sends Continue, nor bypasses UNKNOWN-send or snooze.
    for (const id of restartWorkingOwners) plan.activatedIds.add(id);
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
      if (autoEvicted?.[key] && activeSessionId !== session.id &&
          !deliveryRequests[`${environmentId}:${session.id}`]) return [];
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
        (warmedIds.includes(session.id) &&
          !manuallyUnloaded[key] &&
          !session.hidden &&
          !(session.snoozedUntil && session.snoozedUntil > now)) ||
        activeSessionId === session.id ||
        (userOpened?.[key] === true &&
          !session.hidden && !(session.snoozedUntil && session.snoozedUntil > now)) ||
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
    // The maximum bounds automatic retention only. User-opened sessions
    // remain resident even when they exceed it; snooze/unload releases them.
    const ranked = candidates.toSorted((a, b) => {
      const priority = (key: string) => {
        const id = sessions.find((session) =>
          JSON.stringify([environmentId, chatGPTBrowserThreadRef(environmentId, session.id).threadId]) === key)?.id;
        if (id === activeSessionId) return 0;
        if (id && deliveryRequests[`${environmentId}:${id}`]) return 1;
        return protectedKeys.has(key) ? 2 : 3;
      };
      return priority(a.key) - priority(b.key) || b.lastUsedAt - a.lastUsedAt;
    });
    const selectedKey = activeSessionId
      ? JSON.stringify([environmentId, chatGPTBrowserThreadRef(environmentId, activeSessionId).threadId])
      : null;
    const userKeys = ranked
      .filter(({ key }) => userOpened?.[key] === true || key === selectedKey)
      .map(({ key }) => key);
    const manual = new Set(userKeys);
    const automatic = ranked.filter(({ key }) => !manual.has(key));
    return [...new Set([
      ...userKeys,
      ...recentChatGPTGuestKeys(
        automatic, protectedKeys,
        unloadProfile === "never" ? Number.POSITIVE_INFINITY : maxAutoCount,
      ),
    ])];
  }, [
    activeSessionId,
    environmentId,
    managerIds,
    sessions,
    touchedAt,
    now,
    unloadProfile,
    recentGuests,
    maxAutoCount,
    userOpened,
    deliveryRequests,
    warmedIds,
    manuallyUnloaded,
    autoEvicted,
  ]);

  useEffect(() => retainChatGPTGuests(retainedKeys), [retainedKeys]);
  // Own warmed runtimes whenever the ordinary sidebar is absent (Settings/legacy).
  // The normal sidebar remains the sole owner otherwise, avoiding duplicate opens.
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
      <ChatGPTIdleOverflowUnloader
        environmentId={environmentId}
        sessions={sessions}
        selectedId={activeSessionId}
        maxCount={maxAutoCount}
        deliveryRequests={deliveryRequests}
      />
      <ChatGPTRestartContinuation environmentId={environmentId} />
      {sessions
        .filter((session) => !session.hidden)
        .map((session) => (
          <ChatGPTBackgroundQueueOwner
            key={`queue:${session.id}`}
            environmentId={environmentId}
            sessionId={session.id}
            sessions={sessions}
          />
        ))}
      {sessions
        .filter(
          (session) =>
            deliveryRequests[`${environmentId}:${session.id}`] ||
            uncertainOwners.has(session.id) ||
            (!sidebarRuntimesAvailable && restartWorkingOwners.has(session.id)) ||
            (!sidebarRuntimesAvailable &&
              warmedIds.includes(session.id) &&
              !session.hidden &&
              !(session.snoozedUntil && session.snoozedUntil > now) &&
              !manuallyUnloaded[
                JSON.stringify([
                  environmentId,
                  chatGPTBrowserThreadRef(environmentId, session.id).threadId,
                ])
              ]),
        )
        .map((session) => (
          <ChatGPTBrowserSessionRuntime
            key={session.id}
            environmentId={environmentId}
            sessionId={session.id}
            selected={activeSessionId === session.id}
            suspended={false}
            quiet
          />
        ))}
    </>
  ) : null;
}
