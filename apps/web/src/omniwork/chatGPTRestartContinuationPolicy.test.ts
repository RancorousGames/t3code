import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "../chatGPTBrowserSessions";
import { chatGPTRestartSource, decideChatGPTRestartContinuation } from "./chatGPTRestartContinuationPolicy";

const now = 100_000_000;
const conversationId = "5a45a170-5082-4669-98c6-59909af393fe";
const url = `https://chatgpt.com/c/${conversationId}`;
const session = (role: "manager" | "worker" | "personal" = "worker"): BrowserSession =>
  ({ id: "worker", title: "Managed", binding: {
    role, seatId: "seat", parentSessionId: null, taskRef: null,
    boundAt: "2026-10-29T20:00:00Z", boundBy: "omcp_spawn",
  } }) as BrowserSession;
const old = {
  contentHash: "abcdef12", observedAt: now - 1_000, conversationId, url,
  activity: "working", turnCount: 3, lastAssistant: {
    text: "Partial thought", truncated: false, endsWithQuestion: false,
  }, signals: { stopButton: true, draftPresent: false, signInOrCaptcha: false },
};
const after = { ...old, observedAt: now, activity: "idle",
  signals: { ...old.signals, stopButton: false, composerPresent: true },
};
describe("managed ChatGPT restart continuation guard", () => {
  it("requires managed role and positive interrupted stream evidence", () => {
    expect(chatGPTRestartSource(session("personal"), old, now)).toBeNull();
    expect(chatGPTRestartSource(session(), { ...old, signals: { ...old.signals, stopButton: false } }, now)).toBeNull();
    expect(chatGPTRestartSource(session(), old, now)?.conversationId).toBe(conversationId);
  });
  it("offers at most one candidate on an unchanged idle conversation, never on a newer reply", () => {
    const src = chatGPTRestartSource(session(), old, now)!;
    expect(decideChatGPTRestartContinuation(src, after, now, false)).toBe("continue");
    expect(decideChatGPTRestartContinuation(src, { ...after,
      lastAssistant: { ...old.lastAssistant, text: "Finished!" },
    }, now, false)).toBe("ignore");
    expect(decideChatGPTRestartContinuation(src, after, now, true)).toBe("ignore");
    expect(decideChatGPTRestartContinuation(src, { ...after,
      signals: { ...after.signals, draftPresent: true },
    }, now, false)).toBe("wait");
    expect(decideChatGPTRestartContinuation(src, old, now, false)).toBe("wait");
  });
});
