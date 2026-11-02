import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";

const mocks = vi.hoisted(() => ({
  snapshots: {} as Record<string, unknown>,
}));
vi.mock("./chatGPTSessionPersistedStore", () => ({
  getChatGPTSessionPersistedStore: () => ({
    getState: () => ({ snapshots: mocks.snapshots }),
    setState: (state: { snapshots: Record<string, unknown> }) => {
      mocks.snapshots = state.snapshots;
    },
  }),
}));

import { saveChatGPTPageSnapshot } from "./chatGPTPageSnapshot";

const id = "11111111-1111-4111-8111-111111111111";
const candidate = (
  observedAt: number,
  activity: ChatGPTPageSnapshot["activity"] = "idle",
): ChatGPTPageSnapshot => ({
  observedAt,
  activity,
  conversationId: id,
  url: `https://chatgpt.com/c/${id}`,
  contentHash: "12345678",
  turnCount: 1,
  signals: {
    stopButton: false,
    interruptedBanner: false,
    loadError: false,
    composerPresent: true,
    draftPresent: false,
    signInOrCaptcha: false,
    conversationFull: false,
  },
  lastUser: { text: "Hello", truncated: false },
});

beforeEach(() => {
  mocks.snapshots = {};
});

it("refreshes unchanged conversation liveness without treating it as new transcript content", () => {
  expect(saveChatGPTPageSnapshot("env", "tab", candidate(100_000))).toBe(true);
  expect(saveChatGPTPageSnapshot("env", "tab", candidate(120_000))).toBe(false);
  expect((mocks.snapshots.tab as ChatGPTPageSnapshot).observedAt).toBe(100_000);
  expect(saveChatGPTPageSnapshot("env", "tab", candidate(161_000))).toBe(false);
  expect((mocks.snapshots.tab as ChatGPTPageSnapshot).observedAt).toBe(161_000);
  expect(saveChatGPTPageSnapshot("env", "tab", candidate(170_000, "working"))).toBe(true);
  expect((mocks.snapshots.tab as ChatGPTPageSnapshot).activity).toBe("working");
});
