import type { EnvironmentId } from "@t3tools/contracts";

import {
  BrowserSessions,
  chatGPTBrowserSessionsKey,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import {
  AGENT_ATTENTION_CHANGE_EVENT,
  deferPersistentManualAttention,
  reactivatePersistentManualAttention,
  snoozePersistentManualAttention,
} from "./chatGPTAgentAttention";
import { readChatGPTProviderActivity } from "./chatGPTProviderActivity";
import { deferredCaffyAttention, isCaffyIdleContinuationActive } from "./chatGPTCaffyAttentionPolicy";
import { readVerifiedT3CaffyOverview } from "./hooks/useT3CaffyOverview";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { setLocalStorageItem } from "./hooks/useLocalStorage";

/** A timed session snooze with a persistent Ctrl+D marker becomes attention
 * ready when it expires. A manual unsnooze or a verification hold does not. */
export function persistentAttentionSnoozeDue(
  session: BrowserSession,
  now: number,
): boolean {
  return Boolean(session.returnMarker) &&
    !session.hidden && !session.verificationPending &&
    typeof session.snoozedAt === "number" &&
    typeof session.snoozedUntil === "number" &&
    Number.isFinite(session.snoozedUntil) &&
    session.snoozedUntil >= session.snoozedAt &&
    session.snoozedUntil <= now;
}

function sessionAttentionIds(session: BrowserSession): string[] {
  return [
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ];
}

/** One timer per environment, attached to the mounted desktop alert system.
 * A completed wake clears the persisted snooze timestamp first, making it
 * idempotent across store updates, renderer remounts, and T3 restarts. */
export function watchPersistentChatGPTSessionSnoozes(environmentId: EnvironmentId): () => void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reconciling = false;

  const reconcile = () => {
    if (stopped || reconciling) return;
    reconciling = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    const current = store.getState().sessions;
    const expired = current.filter((session) => persistentAttentionSnoozeDue(session, now));
    if (expired.length > 0) {
      const caffy = readVerifiedT3CaffyOverview();
      const continuingIds = new Set(expired
        .filter((session) => isCaffyIdleContinuationActive(caffy, session, now))
        .map((session) => session.id));
      const due = new Set(expired.map((session) => session.id));
      const next = current.map((session) => due.has(session.id)
        ? {
            ...session,
            snoozedUntil: undefined,
            snoozedAt: undefined,
            quickSnoozeStep: undefined,
            returnMarker: continuingIds.has(session.id) ||
              readChatGPTProviderActivity(environmentId, session.id) === "working"
              ? "working" as const : "ready" as const,
          }
        : session);
      // Persist before announcing. Re-entrant subscriptions and application
      // restarts must not deliver the same wake twice.
      setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
      store.setState({ sessions: next });
      for (const session of expired) {
        const ids = sessionAttentionIds(session);
        if (continuingIds.has(session.id)) {
          // The snooze expired, but Caffy still owns the next continuation.
          // Do not turn yellow or announce the manual request until it stops.
          deferredCaffyAttention.defer(environmentId, session.id);
          deferPersistentManualAttention(ids);
        } else if (readChatGPTProviderActivity(environmentId, session.id) === "working") {
          deferPersistentManualAttention(ids);
        } else {
          reactivatePersistentManualAttention(ids, session.title);
        }
      }
    }

    let nextWake = Number.POSITIVE_INFINITY;
    for (const session of store.getState().sessions) {
      const until = session.snoozedUntil;
      if (!session.returnMarker || session.hidden || session.verificationPending ||
          typeof until !== "number" || !Number.isFinite(until) ||
          until <= now || typeof session.snoozedAt !== "number") continue;
      snoozePersistentManualAttention(sessionAttentionIds(session), until);
      nextWake = Math.min(nextWake, until);
    }
    if (Number.isFinite(nextWake)) {
      timer = setTimeout(reconcile, Math.max(1, Math.min(2_147_483_647, nextWake - Date.now())));
    }
    reconciling = false;
  };

  const unsubscribe = store.subscribe((next, previous) => {
    if (next.sessions !== previous.sessions) reconcile();
  });
  // If a session finishes new work while snoozed, keep its Ctrl+D notification
  // snoozed too; the provider can activate requests independently of the store.
  window.addEventListener(AGENT_ATTENTION_CHANGE_EVENT, reconcile);
  reconcile();
  return () => {
    stopped = true;
    unsubscribe();
    window.removeEventListener(AGENT_ATTENTION_CHANGE_EVENT, reconcile);
    if (timer !== undefined) clearTimeout(timer);
  };
}
