import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isElectron } from "../env";
import { resolveStorage } from "../lib/storage";

// Custom Omniwork preferences stay separate from upstream T3 settings/contracts.
// This is per-device: only Electron hosts embedded ChatGPT guests to unload.
export type OmniworkUnloadProfile = "never" | "conservative" | "balanced" | "aggressive";
export const DEFAULT_OMNIWORK_UNLOAD_PROFILE: OmniworkUnloadProfile = "balanced";
export const DEFAULT_OMNIWORK_RECENT_GUESTS: number | null = null;
export const DEFAULT_CHATGPT_WARM_SESSION_COUNT = 8;
export const DEFAULT_CHATGPT_MAX_AUTO_SESSION_COUNT = 12;
export type LiveTaskStartKind = "chatgpt" | "claude" | "codex";
export function normalizeLiveTaskStartKind(value: unknown): LiveTaskStartKind {
  return value === "claude" || value === "codex" ? value : "chatgpt";
}
export const CHATGPT_WARM_SESSION_COUNTS = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32] as const;

export function normalizeChatGPTWarmSessionCount(value: unknown): number {
  return typeof value === "number" &&
    (CHATGPT_WARM_SESSION_COUNTS as readonly number[]).includes(value)
    ? value
    : DEFAULT_CHATGPT_WARM_SESSION_COUNT;
}

/** Keep ordinary recently used guests in memory, separately from protected sessions. */
export function normalizeOmniworkRecentGuests(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 32
    ? value
    : DEFAULT_OMNIWORK_RECENT_GUESTS;
}

export function normalizeOmniworkUnloadProfile(value: unknown): OmniworkUnloadProfile {
  switch (value) {
    case "never":
    case "conservative":
    case "balanced":
    case "aggressive":
      return value;
    default:
      return DEFAULT_OMNIWORK_UNLOAD_PROFILE;
  }
}

export interface OmniworkUnloadPolicy {
  readonly minRecentGuests: number;
  readonly idleMs: number | null;
}

/** `null` disables automatic unloading; protected sessions are never eligible on any profile. */
export function resolveOmniworkUnloadPolicy(profile: unknown): OmniworkUnloadPolicy {
  switch (normalizeOmniworkUnloadProfile(profile)) {
    case "never":
      return { minRecentGuests: Number.POSITIVE_INFINITY, idleMs: null };
    case "conservative":
      return { minRecentGuests: 8, idleMs: 45 * 60_000 };
    case "aggressive":
      return { minRecentGuests: 3, idleMs: 5 * 60_000 };
    case "balanced":
      // Original defaults: five recent guests, 15-minute verified-idle window.
      return { minRecentGuests: 5, idleMs: 15 * 60_000 };
  }
}

interface OmniworkPreferences {
  readonly unloadProfile: OmniworkUnloadProfile;
  readonly recentGuests: number | null;
  readonly loadAllChatGPTSessionsOnStartup: boolean;
  readonly chatGPTWarmSessionCount: number;
  readonly chatGPTMaxAutoSessionCount: number;
  readonly liveTaskStartKind: LiveTaskStartKind;
  readonly showWorkersWithSelectedParent: boolean;
  readonly erroredSessionsAtBottom: boolean;
  setErroredSessionsAtBottom: (enabled: boolean) => void;
  setShowWorkersWithSelectedParent: (enabled: boolean) => void;
  setLiveTaskStartKind: (kind: LiveTaskStartKind) => void;
  setLoadAllChatGPTSessionsOnStartup: (enabled: boolean) => void;
  setChatGPTWarmSessionCount: (count: number) => void;
  setChatGPTMaxAutoSessionCount: (count: number) => void;
  setRecentGuests: (count: number | null) => void;
  setUnloadProfile: (profile: OmniworkUnloadProfile) => void;
}

export const useOmniworkPreferences = create<OmniworkPreferences>()(
  persist(
    (set) => ({
      unloadProfile: DEFAULT_OMNIWORK_UNLOAD_PROFILE,
      recentGuests: DEFAULT_OMNIWORK_RECENT_GUESTS,
      loadAllChatGPTSessionsOnStartup: false,
      chatGPTWarmSessionCount: DEFAULT_CHATGPT_WARM_SESSION_COUNT,
      chatGPTMaxAutoSessionCount: DEFAULT_CHATGPT_MAX_AUTO_SESSION_COUNT,
      liveTaskStartKind: "chatgpt",
      showWorkersWithSelectedParent: false,
      erroredSessionsAtBottom: true,
      setErroredSessionsAtBottom: (erroredSessionsAtBottom) => set({ erroredSessionsAtBottom }),
      setShowWorkersWithSelectedParent: (showWorkersWithSelectedParent) =>
        set({ showWorkersWithSelectedParent }),
      setLiveTaskStartKind: (liveTaskStartKind) => set({ liveTaskStartKind }),
      setLoadAllChatGPTSessionsOnStartup: (loadAllChatGPTSessionsOnStartup) =>
        set({ loadAllChatGPTSessionsOnStartup }),
      setChatGPTWarmSessionCount: (count) =>
        set((state) => {
          const min = normalizeChatGPTWarmSessionCount(count);
          return {
            chatGPTWarmSessionCount: min,
            chatGPTMaxAutoSessionCount: Math.max(min, state.chatGPTMaxAutoSessionCount),
          };
        }),
      setChatGPTMaxAutoSessionCount: (count) =>
        set((state) => ({
          chatGPTMaxAutoSessionCount: Math.max(
            state.chatGPTWarmSessionCount, normalizeChatGPTWarmSessionCount(count),
          ),
        })),
      setRecentGuests: (recentGuests) =>
        set({ recentGuests: normalizeOmniworkRecentGuests(recentGuests) }),
      setUnloadProfile: (unloadProfile) => set({ unloadProfile }),
    }),
    {
      name: "t3code:omniwork-preferences:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        unloadProfile: state.unloadProfile,
        recentGuests: state.recentGuests,
        loadAllChatGPTSessionsOnStartup: state.loadAllChatGPTSessionsOnStartup,
        chatGPTWarmSessionCount: state.chatGPTWarmSessionCount,
        chatGPTMaxAutoSessionCount: state.chatGPTMaxAutoSessionCount,
        liveTaskStartKind: state.liveTaskStartKind,
        showWorkersWithSelectedParent: state.showWorkersWithSelectedParent,
        erroredSessionsAtBottom: state.erroredSessionsAtBottom,
      }),
      merge: (saved, current) => ({
        ...current,
        unloadProfile: normalizeOmniworkUnloadProfile(
          (saved as Partial<OmniworkPreferences> | null)?.unloadProfile,
        ),
        recentGuests: normalizeOmniworkRecentGuests(
          (saved as Partial<OmniworkPreferences> | null)?.recentGuests,
        ),
        loadAllChatGPTSessionsOnStartup:
          (saved as Partial<OmniworkPreferences> | null)?.loadAllChatGPTSessionsOnStartup === true,
        chatGPTWarmSessionCount: normalizeChatGPTWarmSessionCount(
          (saved as Partial<OmniworkPreferences> | null)?.chatGPTWarmSessionCount,
        ),
        chatGPTMaxAutoSessionCount: Math.max(
          normalizeChatGPTWarmSessionCount(
            (saved as Partial<OmniworkPreferences> | null)?.chatGPTWarmSessionCount,
          ),
          normalizeChatGPTWarmSessionCount(
            (saved as Partial<OmniworkPreferences> | null)?.chatGPTMaxAutoSessionCount ??
              DEFAULT_CHATGPT_MAX_AUTO_SESSION_COUNT,
          ),
        ),
        liveTaskStartKind: normalizeLiveTaskStartKind(
          (saved as Partial<OmniworkPreferences> | null)?.liveTaskStartKind,
        ),
        showWorkersWithSelectedParent:
          (saved as Partial<OmniworkPreferences> | null)?.showWorkersWithSelectedParent === true,
        erroredSessionsAtBottom:
          (saved as Partial<OmniworkPreferences> | null)?.erroredSessionsAtBottom !== false,
      }),
    },
  ),
);

export function activeOmniworkUnloadPolicy(): OmniworkUnloadPolicy {
  return resolveOmniworkUnloadPolicy(
    isElectron ? useOmniworkPreferences.getState().unloadProfile : DEFAULT_OMNIWORK_UNLOAD_PROFILE,
  );
}
