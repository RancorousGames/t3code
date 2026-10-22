import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHATGPT_GUEST_START_SPACING_MS,
  createChatGPTGuestHydrationLimiter,
  shouldStaggerChatGPTGuest,
} from "./chatGPTGuestHydrationLimiter";

describe("ChatGPT restored guest startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T19:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("limits only T3-owned saved ChatGPT conversation guests", () => {
    expect(
      shouldStaggerChatGPTGuest(
        "t3-browser-session:saved",
        "https://chatgpt.com/c/6ad5fa7b-9198-83ed-8adb-0c4d3cfeac7d",
      ),
    ).toBe(true);
    expect(shouldStaggerChatGPTGuest("t3-browser-session:new", "https://chatgpt.com/")).toBe(false);
    expect(
      shouldStaggerChatGPTGuest(
        "other-preview",
        "https://chatgpt.com/c/6ad5fa7b-9198-83ed-8adb-0c4d3cfeac7d",
      ),
    ).toBe(false);
    expect(shouldStaggerChatGPTGuest("t3-browser-session:saved", "https://example.com")).toBe(
      false,
    );
  });

  it("paces starts instead of attaching dozens of webviews at once", async () => {
    const limiter = createChatGPTGuestHydrationLimiter();
    const a = limiter.request("a", new AbortController().signal);
    const b = limiter.request("b", new AbortController().signal);
    const c = limiter.request("c", new AbortController().signal);
    expect(await a).toBe(true);

    let bStarted = false;
    void b.then(() => (bStarted = true));
    await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_START_SPACING_MS - 1);
    expect(bStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await b).toBe(true);

    await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_START_SPACING_MS);
    expect(await c).toBe(true);
  });

  it("prioritizes a newly selected guest without loading its queued neighbors", async () => {
    const limiter = createChatGPTGuestHydrationLimiter();
    expect(await limiter.request("first", new AbortController().signal)).toBe(true);
    const background = limiter.request("background", new AbortController().signal);
    const foreground = limiter.request("foreground", new AbortController().signal);

    limiter.prioritize("foreground");
    expect(await foreground).toBe(true);
    let backgroundStarted = false;
    void background.then(() => (backgroundStarted = true));
    await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_START_SPACING_MS - 1);
    expect(backgroundStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await background).toBe(true);
  });

  it("cancels a detached/hidden guest without delaying remaining work", async () => {
    const limiter = createChatGPTGuestHydrationLimiter();
    expect(await limiter.request("first", new AbortController().signal)).toBe(true);
    const abort = new AbortController();
    const cancelled = limiter.request("detached", abort.signal);
    const remaining = limiter.request("remaining", new AbortController().signal);
    abort.abort();
    expect(await cancelled).toBe(false);

    await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_START_SPACING_MS);
    expect(await remaining).toBe(true);
  });

  it("starts a guest immediately after a long idle period", async () => {
    const limiter = createChatGPTGuestHydrationLimiter();
    expect(await limiter.request("first", new AbortController().signal)).toBe(true);
    await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_START_SPACING_MS * 2);
    expect(await limiter.request("later", new AbortController().signal)).toBe(true);
  });
});
