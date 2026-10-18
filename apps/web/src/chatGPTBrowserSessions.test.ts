import { describe, expect, it } from "vite-plus/test";

import {
  chatGPTSessionTitleFromPage,
  CHATGPT_HIDDEN_EXPIRY_MS,
  expiredHiddenSessionIds,
  isChatGPTConversationUrl,
  reorderChatGPTSessions,
  setChatGPTSessionHidden,
} from "./chatGPTBrowserSessions";

describe("ChatGPT sidebar ordering", () => {
  const sessions = [
    { id: "a", title: "First" },
    { id: "hidden", title: "Hidden", hidden: true },
    { id: "b", title: "Second" },
    { id: "c", title: "Third" },
  ];

  it("moves visible sessions and keeps hidden sessions in their section", () => {
    expect(reorderChatGPTSessions(sessions, "c", "a").map((session) => session.id)).toEqual([
      "c",
      "hidden",
      "a",
      "b",
    ]);
    expect(sessions.map((session) => session.id)).toEqual(["a", "hidden", "b", "c"]);
  });

  it("ignores drops across visible and hidden sections or onto itself", () => {
    expect(reorderChatGPTSessions(sessions, "a", "hidden")).toEqual(sessions);
    expect(reorderChatGPTSessions(sessions, "b", "b")).toEqual(sessions);
    expect(reorderChatGPTSessions(sessions, "missing", "b")).toEqual(sessions);
  });

  it("prepends newly hidden sessions in hide order, preserving live session order", () => {
    const first = setChatGPTSessionHidden(sessions, "c", true);
    expect(first.filter((s) => s.hidden).map((s) => s.id)).toEqual(["c", "hidden"]);
    expect(first.filter((s) => !s.hidden).map((s) => s.id)).toEqual(["a", "b"]);

    const second = setChatGPTSessionHidden(first, "a", true);
    expect(second.filter((s) => s.hidden).map((s) => s.id)).toEqual(["a", "c", "hidden"]);
    expect(second.filter((s) => !s.hidden).map((s) => s.id)).toEqual(["b"]);
    expect(sessions).toEqual([
      { id: "a", title: "First" },
      { id: "hidden", title: "Hidden", hidden: true },
      { id: "b", title: "Second" },
      { id: "c", title: "Third" },
    ]);
  });

  it("restores hidden sessions at the bottom of the live list", () => {
    const hidden = setChatGPTSessionHidden(setChatGPTSessionHidden(sessions, "a", true), "c", true);
    expect(hidden.filter((s) => s.hidden).map((s) => s.id)).toEqual(["c", "a", "hidden"]);

    const restored = setChatGPTSessionHidden(hidden, "c", false);
    expect(restored.filter((s) => !s.hidden).map((s) => s.id)).toEqual(["b", "c"]);
    expect(restored.filter((s) => s.hidden).map((s) => s.id)).toEqual(["a", "hidden"]);

    const next = setChatGPTSessionHidden(restored, "a", false);
    expect(next.filter((s) => !s.hidden).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(next.filter((s) => s.hidden).map((s) => s.id)).toEqual(["hidden"]);
    expect(next.find((s) => s.id === "a")?.hidden).toBe(false);
  });

  it("records the exact hide time and clears it on restore", () => {
    const hidden = setChatGPTSessionHidden(sessions, "a", true);
    expect(hidden.find((entry) => entry.id === "a")?.hiddenAt).toBeGreaterThan(0);
    expect(
      setChatGPTSessionHidden(hidden, "a", false).find((entry) => entry.id === "a")?.hiddenAt,
    ).toBeUndefined();
  });

  it("expires only sessions known to have been hidden for at least three days", () => {
    const now = Date.now();
    const candidates = [
      { id: "expired", title: "old", hidden: true, hiddenAt: now - CHATGPT_HIDDEN_EXPIRY_MS },
      { id: "newer", title: "new", hidden: true, hiddenAt: now - CHATGPT_HIDDEN_EXPIRY_MS + 1 },
      { id: "legacy", title: "legacy", hidden: true },
      { id: "visible", title: "visible", hiddenAt: now - CHATGPT_HIDDEN_EXPIRY_MS - 1 },
    ];
    expect(expiredHiddenSessionIds(candidates, now)).toEqual(["expired"]);
    expect(expiredHiddenSessionIds(candidates, now - 1)).toEqual([]);
  });

  it("preserves order for redundant visibility updates and missing IDs", () => {
    expect(setChatGPTSessionHidden(sessions, "a", false)).toEqual(sessions);
    expect(setChatGPTSessionHidden(sessions, "hidden", true)).toEqual(sessions);
    expect(setChatGPTSessionHidden(sessions, "missing", true)).toEqual(sessions);
  });

  it("can reorder hidden sessions without changing visible order", () => {
    const withTwoHidden = [...sessions, { id: "hidden2", title: "Hidden two", hidden: true }];
    expect(reorderChatGPTSessions(withTwoHidden, "hidden2", "hidden").map((s) => s.id)).toEqual([
      "a",
      "hidden2",
      "b",
      "c",
      "hidden",
    ]);
  });
});

describe("ChatGPT browser session title", () => {
  it("uses the conversation page title without ChatGPT branding", () => {
    expect(chatGPTSessionTitleFromPage("Diagnose an Unreal crash - ChatGPT")).toBe(
      "Diagnose an Unreal crash",
    );
    expect(chatGPTSessionTitleFromPage("ChatGPT | Compare combat designs")).toBe(
      "Compare combat designs",
    );
  });

  it("ignores placeholder and home-page titles", () => {
    for (const title of [
      null,
      "",
      "ChatGPT",
      "ChatGPT - OpenAI",
      "New chat - ChatGPT",
      "Temporary chat",
    ]) {
      expect(chatGPTSessionTitleFromPage(title)).toBeNull();
    }
  });

  it("only treats ChatGPT conversation URLs as candidates for auto-naming", () => {
    expect(isChatGPTConversationUrl("https://chatgpt.com/c/123abc")).toBe(true);
    expect(isChatGPTConversationUrl("https://chatgpt.com/g/g-id/c/123abc?x=1")).toBe(true);
    expect(isChatGPTConversationUrl("https://chatgpt.com/")).toBe(false);
    expect(isChatGPTConversationUrl("https://example.com/c/123abc")).toBe(false);
    expect(isChatGPTConversationUrl(null)).toBe(false);
  });

  it("truncates long conversation titles", () => {
    const title = chatGPTSessionTitleFromPage("X".repeat(100) + " - ChatGPT");
    expect(title).toHaveLength(80);
    expect(title?.endsWith("…")).toBe(true);
  });
});
