// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cancelChatGPTSessionSingleClick,
  chatGPTDoubleClickSnoozeUntil,
  scheduleChatGPTSessionSingleClick,
  CHATGPT_SESSION_CLICK_SETTLE_MS,
} from "./chatGPTDoubleClickSnooze";

afterEach(() => vi.useRealTimers());

describe("session row click intent", () => {
  it("starts a fresh 24-hour snooze each time", () => {
    const firstClick = 1_800_000_000_000;
    expect(chatGPTDoubleClickSnoozeUntil(firstClick)).toBe(firstClick + 86_400_000);
    expect(chatGPTDoubleClickSnoozeUntil(firstClick + 60_000))
      .toBe(firstClick + 60_000 + 86_400_000);
  });
  it("does not navigate or unsnooze when the second click turns into a double-click", () => {
    vi.useFakeTimers();
    const firstClick = vi.fn();
    const timer = { current: null as ReturnType<typeof setTimeout> | null };
    scheduleChatGPTSessionSingleClick(timer, firstClick);
    vi.advanceTimersByTime(200);
    cancelChatGPTSessionSingleClick(timer);
    vi.advanceTimersByTime(CHATGPT_SESSION_CLICK_SETTLE_MS);
    expect(firstClick).not.toHaveBeenCalled();
    expect(chatGPTDoubleClickSnoozeUntil(1000)).toBe(1000 + 24 * 60 * 60_000);
  });

  it("still opens after an unambiguous single click", () => {
    vi.useFakeTimers();
    const firstClick = vi.fn();
    const timer = { current: null as ReturnType<typeof setTimeout> | null };
    scheduleChatGPTSessionSingleClick(timer, firstClick);
    vi.advanceTimersByTime(CHATGPT_SESSION_CLICK_SETTLE_MS);
    expect(firstClick).toHaveBeenCalledOnce();
    expect(timer.current).toBeNull();
  });
});
