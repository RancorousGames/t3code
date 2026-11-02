import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { chatGPTBrowserThreadRef, useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";

/** Snooze overrides guest retention, including after restart; expiry permits attachment again. */
export function useChatGPTSessionSnoozed(threadRef: ScopedThreadRef): boolean {
  const { sessions } = useChatGPTBrowserSessions(threadRef.environmentId);
  const until = sessions.find(
    (session) =>
      chatGPTBrowserThreadRef(threadRef.environmentId, session.id).threadId === threadRef.threadId,
  )?.snoozedUntil;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until || until <= now) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(until - Date.now(), 2_147_483_647)),
    );
    return () => clearTimeout(timer);
  }, [until, now]);
  return !!until && until > now;
}
