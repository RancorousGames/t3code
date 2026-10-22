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
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { usePrimaryEnvironmentId } from "../../state/environments";

/** Keep a small recent working set even when every conversation becomes idle. */
export function ChatGPTGuestRetention() {
  const environmentId = usePrimaryEnvironmentId();
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const activeSessionId = useParams({ strict: false, select: (params) => params.browserSessionId });
  const touchedAt = useChatGPTGuestHibernation((state) => state.touchedAt);
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

  const retainedKeys = useMemo(() => {
    if (!isElectron || !environmentId) return [];
    return recentChatGPTGuestKeys(
      sessions
        .filter(
          (session) => !session.hidden && !(session.snoozedUntil && session.snoozedUntil > now),
        )
        .map((session) => {
          const thread = chatGPTBrowserThreadRef(environmentId, session.id);
          const key = JSON.stringify([environmentId, thread.threadId]);
          return {
            key,
            lastUsedAt: Math.max(
              touchedAt[key] ?? 0,
              getLocalStorageItem(
                chatGPTBrowserLastWorkingKey(environmentId, session.id),
                Schema.Number,
              ) ?? 0,
            ),
          };
        }),
    );
  }, [environmentId, sessions, touchedAt, now]);

  useEffect(() => retainChatGPTGuests(retainedKeys), [retainedKeys]);
  return null;
}
