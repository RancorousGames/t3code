import { describe, expect, it } from "vite-plus/test";
import { chatGPTDoubleClickSnoozeUntil } from "./chatGPTDoubleClickSnooze";

describe("ChatGPT session double-click snooze", () => {
  it("always starts a fresh 24-hour window rather than escalating or shortening it", () => {
    const firstClick = 1_800_000_000_000;
    const nextClick = firstClick + 60_000;
    expect(chatGPTDoubleClickSnoozeUntil(firstClick)).toBe(firstClick + 86_400_000);
    expect(chatGPTDoubleClickSnoozeUntil(nextClick)).toBe(nextClick + 86_400_000);
  });
});
