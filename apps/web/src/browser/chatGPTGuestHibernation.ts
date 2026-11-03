import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import {
  activeOmniworkUnloadPolicy,
  useOmniworkPreferences,
} from "../omniwork/chatGPTUnloadPolicy";

// Hibernation preserves conversation URLs and uses environment/thread keys
// so a server restart can restore an unloaded guest without losing its session.
// Physical eviction never relies on the two-hour sidebar activity color alone.
export const CHATGPT_GUEST_HIBERNATE_AFTER_MS = 15 * 60 * 1_000;

interface ChatGPTGuestHibernationState {
  readonly hibernated: Record<string, true>;
  /** Manual unloading overrides warm-retention until the user opens the session again. */
  readonly manuallyUnloaded: Record<string, true>;
  /** Explicitly woken guests attach immediately instead of queueing behind restores. */
  readonly woken: Record<string, true>;
  readonly touchedAt: Record<string, number>;
  readonly retained: Record<string, true>;
  /** User-opened guests do not compete for automatic retention slots. */
  readonly userOpened: Record<string, true>;
  /** Soft-limit evictions remain cold until a real user or delivery wake. */
  readonly autoEvicted: Record<string, true>;
}

export const useChatGPTGuestHibernation = create<ChatGPTGuestHibernationState>()(
  persist(
    () => ({ hibernated: {}, manuallyUnloaded: {}, woken: {}, touchedAt: {}, retained: {}, userOpened: {}, autoEvicted: {} }),
    {
      name: "t3code:chatgpt-guest-hibernation:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        hibernated: state.hibernated,
        manuallyUnloaded: state.manuallyUnloaded,
        touchedAt: state.touchedAt,
        autoEvicted: state.autoEvicted,
      }),
    },
  ),
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

export function isChatGPTGuestManuallyUnloaded(runtimeTabId: string): boolean {
  return (
    useChatGPTGuestHibernation.getState().manuallyUnloaded?.[chatGPTGuestKey(runtimeTabId)] === true
  );
}

export function isChatGPTGuestWoken(state: ChatGPTGuestHibernationState, runtimeTabId: string) {
  return state.woken[chatGPTGuestKey(runtimeTabId)] === true;
}

export function selectChatGPTGuestHibernated(
  state: ChatGPTGuestHibernationState,
  runtimeTabId: string,
) {
  const key = chatGPTGuestKey(runtimeTabId);
  return (
    state.manuallyUnloaded?.[key] === true ||
    state.autoEvicted?.[key] === true ||
    (state.hibernated[key] === true && state.retained[key] !== true)
  );
}

export const CHATGPT_MIN_RETAINED_GUESTS = 5;

export function recentChatGPTGuestKeys(
  candidates: ReadonlyArray<{ readonly key: string; readonly lastUsedAt: number }>,
  protectedKeys: ReadonlySet<string> = new Set(),
  totalLimit = Number.POSITIVE_INFINITY,
): string[] {
  const policy = activeOmniworkUnloadPolicy();
  const ordinaryLimit =
    policy.idleMs === null
      ? Number.POSITIVE_INFINITY
      : (useOmniworkPreferences.getState().recentGuests ?? policy.minRecentGuests);
  // Important sessions do not compete against the five ordinary recent slots.
  const protectedCandidates = candidates
    .filter(({ key }) => protectedKeys.has(key))
    .map(({ key }) => key);
  const ordinary = [...candidates]
    .filter(({ key }) => !protectedKeys.has(key))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, ordinaryLimit)
    .map(({ key }) => key);
  return [...protectedCandidates, ...ordinary].slice(0, totalLimit);
}

/** Retention overrides old hibernation flags without treating restoration as use. */
export function retainChatGPTGuests(keys: readonly string[]): void {
  const current = useChatGPTGuestHibernation.getState().retained;
  if (Object.keys(current).length === keys.length && keys.every((key) => current[key])) return;
  useChatGPTGuestHibernation.setState((state) => ({
    // Losing a priority slot is not evidence that a guest is idle.
    // Actual eviction requires a fresh verified idle/composer check.
    retained: Object.fromEntries(keys.map((key) => [key, true])),
    hibernated: Object.fromEntries(
      Object.entries(state.hibernated).filter(([key]) => !keys.includes(key)),
    ),
  }));
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

export function hibernateChatGPTGuest(runtimeTabId: string, manual = false): void {
  const key = chatGPTGuestKey(runtimeTabId);
  if (!manual && useChatGPTGuestHibernation.getState().retained[key]) return;
  if (!manual && isChatGPTGuestHibernated(runtimeTabId)) return;
  useChatGPTGuestHibernation.setState((state) => ({
    hibernated: { ...state.hibernated, [key]: true },
    ...(manual ? {
      manuallyUnloaded: { ...state.manuallyUnloaded, [key]: true },
      userOpened: Object.fromEntries(
        Object.entries(state.userOpened ?? {}).filter(([entry]) => entry !== key),
      ),
    } : {}),
  }));
}

/** No-op for a loaded guest, apart from refreshing its idle window. */
export function wakeChatGPTGuest(runtimeTabId: string, now = Date.now()): void {
  const key = chatGPTGuestKey(runtimeTabId);
  useChatGPTGuestHibernation.setState((state) => {
    const { [key]: _wasHibernated, ...hibernated } = state.hibernated;
    const { [key]: _wasManuallyUnloaded, ...manuallyUnloaded } = state.manuallyUnloaded ?? {};
    const { [key]: _wasAutoEvicted, ...autoEvicted } = state.autoEvicted ?? {};
    return {
      hibernated,
      manuallyUnloaded,
      autoEvicted,
      woken: state.woken[key] ? state.woken : { ...state.woken, [key]: true },
      touchedAt: { ...state.touchedAt, [key]: now },
    };
  });
}

export function shouldHibernateChatGPTGuest(input: {
  readonly visible: boolean;
  /** Important managers, sessions with children, or queued recovery remain attached. */
  readonly protected?: boolean;
  readonly longIdle?: boolean;
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
  const baseIdleMs = activeOmniworkUnloadPolicy().idleMs;
  const idleMs = input.longIdle && baseIdleMs !== null ? 4 * 60 * 60_000 : baseIdleMs;
  return idleMs !== null && input.now - lastUsedAt >= idleMs;
}

/** Explicit user navigation may exceed automatic residency limits without evicting other guests. */
export function openChatGPTGuestByUser(runtimeTabId: string): void {
  const key = chatGPTGuestKey(runtimeTabId);
  wakeChatGPTGuest(runtimeTabId);
  useChatGPTGuestHibernation.setState((state) => ({
    userOpened: { ...state.userOpened, [key]: true },
  }));
}

/** Snoozing is an explicit release of the user-opened residency exemption. */
export function clearChatGPTGuestUserOpened(runtimeTabId: string): void {
  const key = chatGPTGuestKey(runtimeTabId);
  useChatGPTGuestHibernation.setState((state) => {
    if (!state.userOpened?.[key]) return state;
    const { [key]: _removed, ...userOpened } = state.userOpened;
    return { userOpened };
  });
}

/** Called only after verifying a background guest is idle with an empty composer. */
export function evictVerifiedIdleChatGPTGuest(runtimeTabId: string): void {
  const key = chatGPTGuestKey(runtimeTabId);
  useChatGPTGuestHibernation.setState((state) => {
    const { [key]: _wasRetained, ...retained } = state.retained;
    const { [key]: _wasUserOpened, ...userOpened } = state.userOpened ?? {};
    return {
      retained,
      userOpened,
      autoEvicted: { ...state.autoEvicted, [key]: true },
      hibernated: { ...state.hibernated, [key]: true },
    };
  });
}
