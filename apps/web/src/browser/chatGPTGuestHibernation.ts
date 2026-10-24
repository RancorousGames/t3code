import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { CHATGPT_RECENT_ACTIVITY_MS } from "../components/sidebar/chatGPTActivity";
import { resolveStorage } from "../lib/storage";

// Each ChatGPT guest costs its own renderer (roughly 0.4-1 GB). Sessions that
// are not shown and have not worked recently are unmounted; their preview
// session and conversation URL stay, so waking simply reloads the guest.
// Callers pass runtime tab ids, but state is keyed by environment and thread:
// the runtime id carries the server epoch, and the hibernated set is persisted
// so a restart restores the loaded guests and the most recently used sessions.
export const CHATGPT_GUEST_HIBERNATE_AFTER_MS = CHATGPT_RECENT_ACTIVITY_MS;

interface ChatGPTGuestHibernationState {
  readonly hibernated: Record<string, true>;
  /** Explicitly woken guests attach immediately instead of queueing behind restores. */
  readonly woken: Record<string, true>;
  readonly touchedAt: Record<string, number>;
  readonly retained: Record<string, true>;
}

export const useChatGPTGuestHibernation = create<ChatGPTGuestHibernationState>()(
  persist(() => ({ hibernated: {}, woken: {}, touchedAt: {}, retained: {} }), {
    name: "t3code:chatgpt-guest-hibernation:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    partialize: (state) => ({ hibernated: state.hibernated, touchedAt: state.touchedAt }),
  }),
);

/** Stable across server restarts: `previewRuntimeTabId` without epoch and tab. */
export function chatGPTGuestKey(runtimeTabId: string): string {
  try {
    const parts: unknown = JSON.parse(runtimeTabId);
    if (Array.isArray(parts)) return JSON.stringify(parts.slice(0, 2));
  } catch {
    // Not a runtime tab id; use it as is.
  }
  return runtimeTabId;
}

export function isChatGPTGuestHibernated(runtimeTabId: string): boolean {
  return selectChatGPTGuestHibernated(useChatGPTGuestHibernation.getState(), runtimeTabId);
}

export function isChatGPTGuestWoken(state: ChatGPTGuestHibernationState, runtimeTabId: string) {
  return state.woken[chatGPTGuestKey(runtimeTabId)] === true;
}

export function selectChatGPTGuestHibernated(
  state: ChatGPTGuestHibernationState,
  runtimeTabId: string,
) {
  const key = chatGPTGuestKey(runtimeTabId);
  return state.hibernated[key] === true && state.retained[key] !== true;
}

export const CHATGPT_MIN_RETAINED_GUESTS = 5;

export function recentChatGPTGuestKeys(
  candidates: ReadonlyArray<{ readonly key: string; readonly lastUsedAt: number }>,
  protectedKeys: ReadonlySet<string> = new Set(),
): string[] {
  const keys = new Set(candidates.map(({ key }) => key));
  // Important sessions do not compete against the five ordinary recent slots.
  const protectedCandidates = [...protectedKeys].filter((key) => keys.has(key));
  const ordinary = [...candidates]
    .filter(({ key }) => !protectedKeys.has(key))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, CHATGPT_MIN_RETAINED_GUESTS)
    .map(({ key }) => key);
  return [...protectedCandidates, ...ordinary];
}

/** Retention overrides old hibernation flags without treating restoration as use. */
export function retainChatGPTGuests(keys: readonly string[]): void {
  const current = useChatGPTGuestHibernation.getState().retained;
  if (Object.keys(current).length === keys.length && keys.every((key) => current[key])) return;
  useChatGPTGuestHibernation.setState({
    retained: Object.fromEntries(keys.map((key) => [key, true])),
  });
}

/** Last real use, preserved across app restarts. */
export function chatGPTGuestTouchedAt(runtimeTabId: string): number | undefined {
  return useChatGPTGuestHibernation.getState().touchedAt[chatGPTGuestKey(runtimeTabId)];
}

/** Records use (shown or driven) so the guest stays loaded for the idle window. */
export function touchChatGPTGuest(runtimeTabId: string, now = Date.now()): void {
  const key = chatGPTGuestKey(runtimeTabId);
  // Visible guests are probed frequently; persist at most one heartbeat per 30 seconds.
  const touchedAt = useChatGPTGuestHibernation.getState().touchedAt;
  const previous = touchedAt[key];
  if (
    previous !== undefined &&
    now >= previous &&
    now - previous < 30_000 &&
    Object.values(touchedAt).every((at) => at <= previous)
  )
    return;
  useChatGPTGuestHibernation.setState((state) => ({
    touchedAt: { ...state.touchedAt, [key]: now },
  }));
}

export function hibernateChatGPTGuest(runtimeTabId: string): void {
  if (useChatGPTGuestHibernation.getState().retained[chatGPTGuestKey(runtimeTabId)]) return;
  if (isChatGPTGuestHibernated(runtimeTabId)) return;
  const key = chatGPTGuestKey(runtimeTabId);
  useChatGPTGuestHibernation.setState((state) => ({
    hibernated: { ...state.hibernated, [key]: true },
  }));
}

/** No-op for a loaded guest, apart from refreshing its idle window. */
export function wakeChatGPTGuest(runtimeTabId: string, now = Date.now()): void {
  const key = chatGPTGuestKey(runtimeTabId);
  useChatGPTGuestHibernation.setState((state) => {
    const { [key]: _wasHibernated, ...hibernated } = state.hibernated;
    return {
      hibernated,
      woken: state.woken[key] ? state.woken : { ...state.woken, [key]: true },
      touchedAt: { ...state.touchedAt, [key]: now },
    };
  });
}

export function shouldHibernateChatGPTGuest(input: {
  readonly visible: boolean;
  /** Important managers, sessions with children, or queued recovery remain attached. */
  readonly protected?: boolean;
  /** Only an existing conversation can be reloaded; fresh home pages await a first prompt. */
  readonly onConversation: boolean;
  readonly activity: string;
  readonly lastWorkingAt: number;
  readonly touchedAt: number;
  readonly now: number;
}): boolean {
  if (input.visible || input.protected || !input.onConversation) return false;
  // Only a positively observed idle conversation is disposable. Unknown,
  // invalid/red, interrupted/orange and working are not evidence of completion.
  if (input.activity !== "idle") return false;
  const lastUsedAt = Math.max(input.lastWorkingAt || 0, input.touchedAt || 0);
  return input.now - lastUsedAt >= CHATGPT_GUEST_HIBERNATE_AFTER_MS;
}
