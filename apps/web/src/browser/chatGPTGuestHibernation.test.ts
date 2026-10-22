import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CHATGPT_GUEST_HIBERNATE_AFTER_MS,
  chatGPTGuestKey,
  hibernateChatGPTGuest,
  isChatGPTGuestHibernated,
  recentChatGPTGuestKeys,
  retainChatGPTGuests,
  selectChatGPTGuestHibernated,
  shouldHibernateChatGPTGuest,
  useChatGPTGuestHibernation,
  touchChatGPTGuest,
  wakeChatGPTGuest,
} from "./chatGPTGuestHibernation";

const now = 10 * CHATGPT_GUEST_HIBERNATE_AFTER_MS;
const stale = {
  visible: false,
  onConversation: true,
  activity: "idle",
  lastWorkingAt: 0,
  touchedAt: 0,
  now,
};

describe("shouldHibernateChatGPTGuest", () => {
  it("unloads a hidden conversation that has been unused for the idle window", () => {
    expect(shouldHibernateChatGPTGuest(stale)).toBe(true);
    expect(shouldHibernateChatGPTGuest({ ...stale, activity: "unknown" })).toBe(true);
  });

  it("keeps shown, fresh, generating and recently used guests loaded", () => {
    expect(shouldHibernateChatGPTGuest({ ...stale, visible: true })).toBe(false);
    expect(shouldHibernateChatGPTGuest({ ...stale, onConversation: false })).toBe(false);
    for (const activity of ["working", "interrupted", "delivery-timeout"])
      expect(shouldHibernateChatGPTGuest({ ...stale, activity })).toBe(false);
    expect(shouldHibernateChatGPTGuest({ ...stale, lastWorkingAt: now - 1_000 })).toBe(false);
    expect(shouldHibernateChatGPTGuest({ ...stale, touchedAt: now - 1_000 })).toBe(false);
  });
});

describe("chatGPT guest hibernation store", () => {
  beforeEach(() =>
    useChatGPTGuestHibernation.setState({ hibernated: {}, woken: {}, touchedAt: {}, retained: {} }),
  );

  it("waking reverses hibernation and restarts the idle window", () => {
    hibernateChatGPTGuest("tab");
    expect(isChatGPTGuestHibernated("tab")).toBe(true);
    wakeChatGPTGuest("tab", now);
    expect(isChatGPTGuestHibernated("tab")).toBe(false);
    const state = useChatGPTGuestHibernation.getState();
    expect(state.woken.tab).toBe(true);
    expect(
      shouldHibernateChatGPTGuest({ ...stale, touchedAt: state.touchedAt.tab ?? 0, now: now + 1 }),
    ).toBe(false);
  });

  it("shares state across server epochs and tabs of one session", () => {
    hibernateChatGPTGuest(JSON.stringify(["env", "thread", "epoch-1", "tab-1"]));
    expect(isChatGPTGuestHibernated(JSON.stringify(["env", "thread", "epoch-2", "tab-9"]))).toBe(
      true,
    );
    expect(chatGPTGuestKey(JSON.stringify(["env", "thread", "epoch-1", "tab-1"]))).toBe(
      JSON.stringify(["env", "thread"]),
    );
  });

  it("restores and protects the latest five idle sessions without changing recency", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      key: `session-${i}`,
      lastUsedAt: i,
    }));
    for (const candidate of candidates) hibernateChatGPTGuest(candidate.key);
    const keys = recentChatGPTGuestKeys(candidates);
    expect(keys).toEqual(["session-7", "session-6", "session-5", "session-4", "session-3"]);
    retainChatGPTGuests(keys);
    for (const key of keys) {
      expect(isChatGPTGuestHibernated(key)).toBe(false);
      hibernateChatGPTGuest(key);
      expect(selectChatGPTGuestHibernated(useChatGPTGuestHibernation.getState(), key)).toBe(false);
    }
    expect(isChatGPTGuestHibernated("session-2")).toBe(true);
    expect(useChatGPTGuestHibernation.getState().touchedAt).toEqual({});
    retainChatGPTGuests(["session-2", ...keys.slice(0, 4)]);
    expect(isChatGPTGuestHibernated("session-3")).toBe(true);
    expect(isChatGPTGuestHibernated("session-2")).toBe(false);
  });

  it("persists interaction order across app restarts and server epochs", async () => {
    const id = JSON.stringify(["env", "thread", "old-epoch", "tab-1"]);
    touchChatGPTGuest(id, 123_000);
    const { storage, name } = useChatGPTGuestHibernation.persist.getOptions();
    if (!storage || !name) throw new Error("Missing persistence storage");
    const saved = await storage.getItem(name);
    expect(saved).toMatchObject({
      state: { touchedAt: { [JSON.stringify(["env", "thread"])]: 123_000 } },
    });
    useChatGPTGuestHibernation.setState({ touchedAt: {} });
    await storage.setItem(name, saved!);
    await useChatGPTGuestHibernation.persist.rehydrate();
    expect(useChatGPTGuestHibernation.getState().touchedAt).toEqual({
      [chatGPTGuestKey(JSON.stringify(["env", "thread", "new-epoch", "tab-2"]))]: 123_000,
    });
  });

  it("keeps all available sessions when fewer than five exist", () => {
    expect(recentChatGPTGuestKeys([{ key: "only", lastUsedAt: 0 }])).toEqual(["only"]);
  });

  it("records quick switches between sessions while throttling repeated probes", () => {
    touchChatGPTGuest("first", 100_000);
    touchChatGPTGuest("first", 101_000);
    expect(useChatGPTGuestHibernation.getState().touchedAt.first).toBe(100_000);
    touchChatGPTGuest("second", 102_000);
    touchChatGPTGuest("first", 103_000);
    const state = useChatGPTGuestHibernation.getState();
    expect(state.touchedAt.first).toBe(103_000);
    expect(state.touchedAt.second).toBe(102_000);
  });
});
