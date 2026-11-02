import * as Schema from "effect/Schema";
import type { ChatGPTRegistrySession, ChatGPTRegistrySnapshot } from "@t3tools/contracts";

import { BrowserSession } from "./chatGPTBrowserSessions";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";

/** Do not trust an untyped server record as a local BrowserSession. */
export function registryBrowserSession(row: ChatGPTRegistrySession): BrowserSession | null {
  const decoded = Schema.decodeUnknownOption(BrowserSession)(row.record);
  if (decoded._tag !== "Some" || decoded.value.id !== row.sessionId) return null;
  return decoded.value;
}


/**
 * The established sidebar/session-view consumers still read the local Zustand
 * cache. Hydrate missing/older cache evidence from the server before presenting
 * it, without waking guests, copying drafts, or erasing local recovery state.
 */
export function hydrateRegistryEvidence(
  environmentId: string,
  rows: readonly ChatGPTRegistrySession[],
): number {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const state = store.getState();
  const snapshots = { ...state.snapshots };
  const timeline = { ...state.timeline };
  const known = new Set(state.sessions.map((session) => session.id));
  let updates = 0;
  for (const row of rows) {
    if (!known.has(row.sessionId) || row.closedAt !== null) continue;
    const remote = registryPageSnapshot(row.snapshot);
    const local = snapshots[row.sessionId] as ChatGPTPageSnapshot | undefined;
    if (remote && (!local || !Number.isFinite(local.observedAt) || remote.observedAt > local.observedAt)) {
      snapshots[row.sessionId] = remote;
      updates++;
    }
    if (row.timeline) {
      const previous = timeline[row.sessionId] ?? {};
      const merged = { ...previous };
      let changed = false;
      for (const key of ["active", "refresh", "reboot"] as const) {
        const serverValue = row.timeline[key];
        const localValue = previous[key] ?? 0;
        if (typeof serverValue === "number" && Number.isFinite(serverValue) && serverValue > localValue) {
          merged[key] = serverValue;
          changed = true;
        }
      }
      if (changed) {
        timeline[row.sessionId] = merged;
        updates++;
      }
    }
  }
  if (updates) store.setState({ snapshots, timeline });
  return updates;
}

/** Normalize historical snapshots; missing fields stay unknown, never invented
 * from a session title. Only a canonical URL can produce a page projection. */
export function registryPageSnapshot(snapshot: ChatGPTRegistrySnapshot | null): ChatGPTPageSnapshot | null {
  if (!snapshot?.url || !snapshot.conversationId ||
      snapshot.conversationId !== chatGPTConversationIdFromUrl(snapshot.url) ||
      !Number.isSafeInteger(snapshot.turnCount) || !snapshot.turnCount ||
      !snapshot.activity) return null;
  const signal = (key: string) => snapshot.signals?.[key] === true;
  return {
    observedAt: snapshot.observedAt,
    url: snapshot.url,
    conversationId: snapshot.conversationId,
    turnCount: snapshot.turnCount,
    activity: snapshot.activity,
    contentHash: snapshot.contentHash,
    signals: {
      stopButton: signal("stopButton"),
      interruptedBanner: signal("interruptedBanner"),
      loadError: signal("loadError"),
      composerPresent: signal("composerPresent"),
      // Unknown remote draft state must NEVER certify an empty composer.
      draftPresent: true,
      signInOrCaptcha: signal("signInOrCaptcha"),
      conversationFull: signal("conversationFull"),
    },
    ...(snapshot.lastUserText ? { lastUser: { text: snapshot.lastUserText, truncated: true } } : {}),
    ...(snapshot.lastAssistantText ? { lastAssistant: {
      text: snapshot.lastAssistantText, truncated: true,
      endsWithQuestion: snapshot.lastAssistantEndsWithQuestion === true,
    } } : {}),
  };
}
