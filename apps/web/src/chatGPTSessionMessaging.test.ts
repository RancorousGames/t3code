import { describe, expect, it } from "vite-plus/test";
import { chatGPTSentTurnObserved, prepareChatGPTSessionMessage } from "./chatGPTSessionMessaging";

const sessions = [
  { id: "source-uuid", title: "Parent" },
  { id: "target-uuid", title: "Worker" },
  { id: "hidden-uuid", title: "Hidden", hidden: true },
];

describe("local ChatGPT inter-session messaging", () => {
  it("confirms only a newly rendered exact user turn, accounting for whitespace reflow", () => {
    expect(
      chatGPTSentTurnObserved(
        "From parent:\n  work done",
        [{ role: "user", text: "From parent:  work done" }],
        2,
        3,
      ),
    ).toBe(true);
    expect(chatGPTSentTurnObserved("Do work", [{ role: "user", text: "Do work" }], 2, 2)).toBe(
      false,
    );
    expect(chatGPTSentTurnObserved("Do work", [{ role: "assistant", text: "Do work" }], 2, 3)).toBe(
      false,
    );
    expect(chatGPTSentTurnObserved("Do work", [{ role: "user", text: "Work done" }], 2, 3)).toBe(
      false,
    );
  });
  it("preserves legacy user messages without inventing a source", () => {
    const result = prepareChatGPTSessionMessage(sessions, "target-uuid", "  Continue task  ");
    expect(result.text).toBe("Continue task");
    expect(result.sender).toBeNull();
    expect(result.recipient.id).toBe("target-uuid");
  });

  it("clearly identifies a caller-supplied source and the recipient without elevating trust", () => {
    const result = prepareChatGPTSessionMessage(
      sessions,
      "target-uuid",
      "Review your tests.",
      "source-uuid",
    );
    expect(result.sender?.id).toBe("source-uuid");
    expect(result.text).toContain("not authenticated");
    expect(result.text).toContain('From browser session: "source-uuid"');
    expect(result.text).toContain('To browser session: "target-uuid"');
    expect(result.text.endsWith("\nReview your tests.")).toBe(true);
  });

  it("rejects unknown, hidden and self-targeting source/recipients", () => {
    expect(() => prepareChatGPTSessionMessage(sessions, "unknown", "Hello")).toThrow(/recipient/);
    expect(() => prepareChatGPTSessionMessage(sessions, "hidden-uuid", "Hello")).toThrow(
      /recipient/,
    );
    expect(() => prepareChatGPTSessionMessage(sessions, "target-uuid", "Hello", "unknown")).toThrow(
      /sender/,
    );
    expect(() =>
      prepareChatGPTSessionMessage(sessions, "target-uuid", "Hello", "hidden-uuid"),
    ).toThrow(/sender/);
    expect(() =>
      prepareChatGPTSessionMessage(sessions, "target-uuid", "Hello", "target-uuid"),
    ).toThrow(/differ/);
  });
});
