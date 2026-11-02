import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";
export { inspectChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";
export type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";

/** Persist content changes and a throttled liveness timestamp from attached page probes.
 * Hibernation and snooze deliberately leave the previous observation intact. */
export function saveChatGPTPageSnapshot(
  environmentId: string,
  sessionId: string,
  candidate: ChatGPTPageSnapshot | null,
): boolean {
  if (
    !candidate ||
    !sessionId ||
    candidate.turnCount <= 0 ||
    !Number.isFinite(candidate.observedAt) ||
    !candidate.conversationId ||
    !/^[0-9a-f]{8}$/.test(candidate.contentHash) ||
    (candidate.lastUser?.text.length ?? 0) > 600 ||
    (candidate.lastAssistant?.text.length ?? 0) > 600
  )
    return false;
  try {
    const url = new URL(candidate.url);
    const pathMatch = url.pathname.match(
      /^(?:\/g\/[^/]+)?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i,
    );
    if (
      url.protocol !== "https:" ||
      !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname) ||
      pathMatch?.[1]?.toLowerCase() !== candidate.conversationId.toLowerCase()
    )
      return false;
    const store = getChatGPTSessionPersistedStore(environmentId);
    const state = store.getState();
    const previous = state.snapshots?.[sessionId] as ChatGPTPageSnapshot | undefined;
    if (
      previous?.contentHash === candidate.contentHash &&
      previous.conversationId === candidate.conversationId &&
      previous.url === candidate.url &&
      previous.activity === candidate.activity &&
      JSON.stringify(previous.signals) === JSON.stringify(candidate.signals)
    ) {
      // Unchanged turns are still a fresh, verified page observation. Refresh
      // liveness at most once a minute without re-indexing the same transcript.
      if (candidate.observedAt - previous.observedAt >= 60_000) {
        store.setState({
          snapshots: {
            ...state.snapshots,
            [sessionId]: { ...previous, observedAt: candidate.observedAt },
          },
        });
      }
      return false;
    }
    store.setState({ snapshots: { ...state.snapshots, [sessionId]: candidate } });
    return true;
  } catch {
    return false; // Unavailable storage must never affect the activity/recovery probe.
  }
}
