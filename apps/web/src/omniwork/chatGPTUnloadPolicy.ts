import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isElectron } from "../env";
import { resolveStorage } from "../lib/storage";

// Custom Omniwork preferences stay separate from upstream T3 settings/contracts.
// This is per-device: only Electron hosts embedded ChatGPT guests to unload.
export type OmniworkUnloadProfile = "never" | "conservative" | "balanced" | "aggressive";
export const DEFAULT_OMNIWORK_UNLOAD_PROFILE: OmniworkUnloadProfile = "balanced";

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
  setUnloadProfile: (profile: OmniworkUnloadProfile) => void;
}

export const useOmniworkPreferences = create<OmniworkPreferences>()(
  persist(
    (set) => ({
      unloadProfile: DEFAULT_OMNIWORK_UNLOAD_PROFILE,
      setUnloadProfile: (unloadProfile) => set({ unloadProfile }),
    }),
    {
      name: "t3code:omniwork-preferences:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ unloadProfile: state.unloadProfile }),
      merge: (saved, current) => ({
        ...current,
        unloadProfile: normalizeOmniworkUnloadProfile(
          (saved as Partial<OmniworkPreferences> | null)?.unloadProfile,
        ),
      }),
    },
  ),
);

export function activeOmniworkUnloadPolicy(): OmniworkUnloadPolicy {
  return resolveOmniworkUnloadPolicy(
    isElectron ? useOmniworkPreferences.getState().unloadProfile : DEFAULT_OMNIWORK_UNLOAD_PROFILE,
  );
}
