import { describe, expect, it } from "vite-plus/test";
import { isSelectedChatGPTError } from "./chatGPTSelectedErrorRecovery";
describe("selected red recovery while background paused", () => {
  it("retries verified errors only", () => {
    expect(isSelectedChatGPTError({ status: "stuck", uiColor: "invalid" })).toBe(true);
    expect(isSelectedChatGPTError({ status: "unavailable", uiColor: "invalid", recoveryProblem: "browser-unresponsive" })).toBe(true);
    for (const status of ["hidden", "hibernated", "loading", "settings", "conversation_full"])
      expect(isSelectedChatGPTError({ status, uiColor: "invalid" })).toBe(false);
    expect(isSelectedChatGPTError({ status: "stuck_connecting", uiColor: "interrupted" })).toBe(false);
    expect(isSelectedChatGPTError({ status: "idle", uiColor: "recent" })).toBe(false);
    expect(isSelectedChatGPTError({ status: "stuck", uiColor: "invalid", activity: "working" })).toBe(false);
  });
});
