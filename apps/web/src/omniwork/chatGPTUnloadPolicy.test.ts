import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../env", () => ({ isElectron: true }));

import {
  DEFAULT_OMNIWORK_UNLOAD_PROFILE,
  activeOmniworkUnloadPolicy,
  normalizeOmniworkUnloadProfile,
  resolveOmniworkUnloadPolicy,
  useOmniworkPreferences,
} from "./chatGPTUnloadPolicy";
import {
  recentChatGPTGuestKeys,
  shouldHibernateChatGPTGuest,
} from "../browser/chatGPTGuestHibernation";

beforeEach(() => {
  useOmniworkPreferences.setState({ unloadProfile: DEFAULT_OMNIWORK_UNLOAD_PROFILE });
});

describe("Omniwork desktop ChatGPT unload preferences", () => {
  it("preserves the pre-existing default and rejects invalid persisted profiles", () => {
    expect(activeOmniworkUnloadPolicy()).toEqual({ minRecentGuests: 5, idleMs: 900_000 });
    expect(normalizeOmniworkUnloadProfile("fastest")).toBe("balanced");
    expect(resolveOmniworkUnloadPolicy(undefined)).toEqual(activeOmniworkUnloadPolicy());
  });

  it("never allows a profile to evict working, unknown, unresolved, protected or visible guests", () => {
    const stale = {
      visible: false,
      protected: false,
      onConversation: true,
      activity: "idle",
      lastWorkingAt: 0,
      touchedAt: 0,
      now: 4_000_000,
    };
    for (const profile of ["never", "conservative", "balanced", "aggressive"] as const) {
      useOmniworkPreferences.getState().setUnloadProfile(profile);
      expect(shouldHibernateChatGPTGuest({ ...stale, protected: true })).toBe(false);
      expect(shouldHibernateChatGPTGuest({ ...stale, visible: true })).toBe(false);
      expect(shouldHibernateChatGPTGuest({ ...stale, onConversation: false })).toBe(false);
      for (const activity of ["working", "unknown", "interrupted", "delivery-timeout", "invalid"]) {
        expect(shouldHibernateChatGPTGuest({ ...stale, activity })).toBe(false);
      }
    }
  });

  it("changes idle thresholds and ordinary retention while preserving protected keys", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      key: `guest-${i}`,
      lastUsedAt: i,
    }));
    const protectedKeys = new Set(["guest-0", "guest-1"]);
    const ordinary = (profile: "aggressive" | "balanced" | "conservative" | "never") => {
      useOmniworkPreferences.getState().setUnloadProfile(profile);
      return recentChatGPTGuestKeys(candidates, protectedKeys);
    };
    expect(ordinary("aggressive")).toHaveLength(5); // 2 protected + 3 ordinary
    expect(ordinary("balanced")).toHaveLength(7);
    expect(ordinary("conservative")).toHaveLength(10);
    expect(ordinary("never")).toHaveLength(12);
    expect(ordinary("never")).toContain("guest-0");

    const stale = {
      visible: false,
      onConversation: true,
      activity: "idle",
      lastWorkingAt: 0,
      touchedAt: 100_000,
      now: 100_000 + 20 * 60_000,
    };
    expect(shouldHibernateChatGPTGuest(stale)).toBe(false);
    useOmniworkPreferences.getState().setUnloadProfile("aggressive");
    expect(shouldHibernateChatGPTGuest(stale)).toBe(true);
    useOmniworkPreferences.getState().setUnloadProfile("conservative");
    expect(shouldHibernateChatGPTGuest(stale)).toBe(false);
    useOmniworkPreferences.getState().setUnloadProfile("balanced");
    expect(shouldHibernateChatGPTGuest(stale)).toBe(true);
  });

  it("persists choices, restores valid settings and rolls corrupt storage back to balanced", async () => {
    const store = useOmniworkPreferences;
    const { storage, name } = store.persist.getOptions();
    if (!storage || !name) throw new Error("Omniwork storage not configured");
    store.getState().setUnloadProfile("conservative");
    const saved = await storage.getItem(name);
    expect(saved).toMatchObject({ state: { unloadProfile: "conservative" } });
    store.getState().setUnloadProfile("aggressive");
    await storage.setItem(name, saved!);
    await store.persist.rehydrate();
    expect(store.getState().unloadProfile).toBe("conservative");
    await storage.setItem(name, { state: { unloadProfile: "expired-invalid-option" }, version: 0 });
    await store.persist.rehydrate();
    expect(store.getState().unloadProfile).toBe("balanced");
    expect(typeof store.getState().setUnloadProfile).toBe("function");
  });
});
