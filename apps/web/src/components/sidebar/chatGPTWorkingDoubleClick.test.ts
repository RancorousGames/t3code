import { describe, expect, it } from "vite-plus/test";
import { workingDoubleClickAction } from "./chatGPTWorkingDoubleClick";

describe("ChatGPT working-session double click", () => {
  it("hides a consistently working session instead of snoozing", () => {
    expect(workingDoubleClickAction(true, true)).toBe("hide-working");
  });
  it("ignores a state transition across clicks instead of accidentally snoozing", () => {
    expect(workingDoubleClickAction(true, false)).toBe("ignore");
    expect(workingDoubleClickAction(false, true)).toBe("ignore");
  });
  it("keeps the existing double-click snooze for consistently inactive sessions", () => {
    expect(workingDoubleClickAction(false, false)).toBe("snooze");
  });
});
