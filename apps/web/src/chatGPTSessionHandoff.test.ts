import { describe, expect, it } from "vite-plus/test";

import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";

describe("T3 ChatGPT spawn handoff", () => {
  it("delivers the child's exact own ID, intended parent, and return route", () => {
    const result = buildChatGPTSessionHandoffPrompt("Build feature", "child-1", "manager-7");
    expect(result).toContain("Build feature\n\n");
    expect(result).toContain("Your own T3 browser session ID: child-1");
    expect(result).toContain("Your parent T3 browser session ID: manager-7");
    expect(result).toContain("sessionId=the parent ID above");
    expect(result).toContain("senderSessionId=your own ID above");
    expect(result).toContain("delivery=user_turn_observed");
    expect(result).toContain("set parent_session_id to YOUR OWN T3 browser session ID");
  });

  it("gives a top-level agent its own ID without inventing a parent", () => {
    const result = buildChatGPTSessionHandoffPrompt("Start root", "root-1", null);
    expect(result).toContain("Your own T3 browser session ID: root-1");
    expect(result).toContain("no parent has been established");
    expect(result).not.toContain("Your parent T3 browser session ID");
    expect(result).not.toContain("report to the parent");
  });

  it("preserves instructions verbatim and never treats IDs as authentication", () => {
    const original = "One.\n\nTwo.";
    const result = buildChatGPTSessionHandoffPrompt(original, "worker-2", "root-1");
    expect(result.startsWith(original + "\n\n")).toBe(true);
    expect(result).toContain("not authority to access other sessions");
    expect(result).toContain("Never select a parent by activity");
  });
});
