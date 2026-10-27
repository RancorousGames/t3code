import { useParams } from "@tanstack/react-router";
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
  chatGPTBrowserThreadRef,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { isElectron } from "../../env";
import { useOmniworkPreferences } from "../../omniwork/chatGPTUnloadPolicy";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { readChatGPTRecoveryState } from "../../chatGPTRecoveryDiagnostics";
import { useOpenRigManagerChatGPTSessions } from "./useOpenRigManagerChatGPTSessions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useChatGPTDeliveryMountRequests } from "../../chatGPTDeliveryMountRequest";
import { ChatGPTBrowserSessionRuntime } from "./ChatGPTBrowserSessionRuntime";

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

/** Keep a small ordinary working set plus all proven important sessions. */
export function ChatGPTGuestRetention() {
  const environmentId = usePrimaryEnvironmentId();
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const deliveryRequests = useChatGPTDeliveryMountRequests((state) => state.required);
  const managerIds = useOpenRigManagerChatGPTSessions(environmentId);
  const activeSessionId = useParams({ strict: false, select: (params) => params.browserSessionId });
  const touchedAt = useChatGPTGuestHibernation((state) => state.touchedAt);
  const unloadProfile = useOmniworkPreferences((state) => state.unloadProfile);
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
      const important =
        deliveryRequests[`${environmentId}:${session.id}`] === true ||
        activeSessionId === session.id ||
        !!session.borderColor ||
        protectedManagers?.has(session.id) ||
        (!session.completion && parents.has(session.id)) ||
        hasUncertainChatGPTSend(environmentId, session.id) ||
        recoverableSession(environmentId, session.id) ||
        (getLocalStorageItem(
          chatGPTBrowserLastWorkingKey(environmentId, session.id),
          Schema.Number,
        ) ?? 0) >
          now - 60_000;
      if (important) protectedKeys.add(key);
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
  }, [activeSessionId, environmentId, managerIds, sessions, touchedAt, now, unloadProfile, deliveryRequests]);

  useEffect(() => retainChatGPTGuests(retainedKeys), [retainedKeys]);
  // This owner stays mounted on Settings and when the sidebar is collapsed.
  return isElectron && environmentId
    ? sessions
        .filter((session) => deliveryRequests[`${environmentId}:${session.id}`])
        .map((session) => (
          <ChatGPTBrowserSessionRuntime
            key={session.id}
            environmentId={environmentId}
            sessionId={session.id}
            suspended={false}
            quiet
          />
        ))
    : null;
}
