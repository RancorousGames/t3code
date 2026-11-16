// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CHATGPT_CAFFY_SNOOZE_UNTIL, wakeChatGPTBrowserSession } from "./chatGPTBrowserSessions";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { chatGPTDoubleClickSnoozeUntil } from "./components/sidebar/chatGPTDoubleClickSnooze";

const env = "t3-0276-quick-snooze";
const id = "worker";
const now = 1_800_000_000_000;
let store: ReturnType<typeof getChatGPTSessionPersistedStore>;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      key: () => null,
      length: 0,
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  store = getChatGPTSessionPersistedStore(env);
  store.setState({ sessions: [{ id, title: "Worker", quickSnoozeStep: 0,
    snoozedUntil: chatGPTDoubleClickSnoozeUntil(now), snoozedAt: now }] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("24-hour ChatGPT quick snooze persistence", () => {
  it("does not wake on incidental activity but still wakes on a real message", () => {
    const until = chatGPTDoubleClickSnoozeUntil(now);
    wakeChatGPTBrowserSession(env, id, "activity");
    expect(store.getState().sessions[0]?.snoozedUntil).toBe(until);

    wakeChatGPTBrowserSession(env, id, "message");
    expect(store.getState().sessions[0]?.snoozedUntil).toBeUndefined();
    expect(store.getState().sessions[0]?.quickSnoozeStep).toBeUndefined();
  });

  it("keeps a Caffy snooze indefinitely until a real message wakes it", () => {
    store.setState({ sessions: [{ id, title: "Worker", quickSnoozeStep: 0,
      snoozedUntil: CHATGPT_CAFFY_SNOOZE_UNTIL, snoozedAt: now }] });
    wakeChatGPTBrowserSession(env, id, "activity");
    expect(store.getState().sessions[0]?.snoozedUntil).toBe(CHATGPT_CAFFY_SNOOZE_UNTIL);
    wakeChatGPTBrowserSession(env, id, "message");
    expect(store.getState().sessions[0]?.snoozedUntil).toBeUndefined();
  });

  it("preserves the previous ambient wake behavior for an ordinary snooze", () => {
    store.setState({ sessions: [{ id, title: "Worker", snoozedUntil: now + 60_000 }] });
    wakeChatGPTBrowserSession(env, id, "activity");
    expect(store.getState().sessions[0]?.snoozedUntil).toBeUndefined();
  });
});
