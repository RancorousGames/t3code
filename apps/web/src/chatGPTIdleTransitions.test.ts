import { describe, expect, it } from "vite-plus/test";
import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";
import { observeChatGPTIdleSnapshot, readChatGPTIdleTransition } from "./chatGPTIdleTransitions";

const conversation = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const sid = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const env = "test-environment";
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    dump: () => [...data.values()],
  };
}
function snap(
  at: number,
  activity: ChatGPTPageSnapshot["activity"],
  opts: Partial<ChatGPTPageSnapshot> = {},
): ChatGPTPageSnapshot {
  const signals = {
    stopButton: activity === "working",
    interruptedBanner: false,
    loadError: false,
    composerPresent: true,
    draftPresent: false,
    signInOrCaptcha: false,
    conversationFull: false,
  };
  return {
    observedAt: at,
    activity,
    conversationId: conversation,
    url: `https://chatgpt.com/c/${conversation}`,
    signals,
    contentHash: "12345678",
    turnCount: 2,
    lastTurnRole: "assistant",
    lastAssistant: { text: "Finished answer", truncated: false, endsWithQuestion: false },
    ...opts,
  };
}
function emit(
  store: ReturnType<typeof storage>,
  at: number,
  activity: ChatGPTPageSnapshot["activity"],
  opts: Partial<ChatGPTPageSnapshot> = {},
) {
  return observeChatGPTIdleSnapshot(env, sid, "2026-10-30T12:00Z", snap(at, activity, opts), store);
}
describe("T3-0228 ChatGPT idle-completion events", () => {
  it("emits once after independently confirmed completion, never for repeated idle snapshots", () => {
    const s = storage();
    expect(emit(s, 1000, "working").event).toBeNull();
    expect(emit(s, 1200, "idle")).toEqual({ confirmAgain: true, event: null });
    expect(emit(s, 1800, "idle").event).toBeNull();
    const result = emit(s, 2000, "idle");
    expect(result.event).toMatchObject({
      sessionId: sid,
      environmentId: env,
      conversationId: conversation,
      sequence: 1,
      turnCount: 2,
      bindingRevision: "2026-10-30T12:00Z",
    });
    expect(emit(s, 2200, "idle").event).toBeNull();
    expect(readChatGPTIdleTransition(env, sid, s)?.eventId).toBe(result.event?.eventId);
    expect(s.dump().join(" ")).not.toContain("Finished answer");
  });
  it("rejects a user-only/placeholder turn and transient interruption", () => {
    const s = storage();
    emit(s, 1000, "working");
    expect(emit(s, 1900, "idle", { lastTurnRole: "user" }).event).toBeNull();
    expect(
      emit(s, 2000, "idle", {
        lastAssistant: { text: "", truncated: false, endsWithQuestion: false },
      }).event,
    ).toBeNull();
    emit(s, 2100, "interrupted");
    expect(emit(s, 3000, "idle").event).toBeNull();
  });
  it("accepts only a witnessed human Stop on the exact working turn, twice-confirmed idle", () => {
    const s = storage();
    const userOnly = {
      lastTurnRole: "user" as const,
      lastAssistant: undefined,
    };
    expect(emit(s, 1000, "working", userOnly).event).toBeNull();
    expect(emit(s, 1100, "idle", userOnly).event).toBeNull();
    const stopped = {
      ...userOnly,
      signals: { ...snap(1900, "idle").signals, explicitStopRequested: true },
    };
    expect(emit(s, 1900, "idle", stopped).confirmAgain).toBe(true);
    const accepted = emit(s, 2800, "idle", stopped).event;
    expect(accepted).toMatchObject({ sequence: 1, kind: "stopped" });
    expect(emit(s, 3000, "idle", stopped).event).toBeNull();
    emit(s, 3100, "working", userOnly);
    expect(emit(s, 4000, "idle", {
      ...stopped, signals: { ...stopped.signals, draftPresent: true },
    }).event).toBeNull();
    expect(emit(s, 4900, "idle", {
      ...userOnly, signals: { ...snap(4900, "idle").signals, interruptedBanner: true },
    }).event).toBeNull();
  });
  it("requires stable response content and correct current conversation", () => {
    const s = storage();
    emit(s, 1000, "working");
    expect(emit(s, 1100, "idle").confirmAgain).toBe(true);
    expect(emit(s, 2000, "idle", { contentHash: "87654321" }).confirmAgain).toBe(true);
    expect(emit(s, 2200, "idle", { contentHash: "87654321" }).event).toBeNull();
    expect(emit(s, 2800, "idle", { contentHash: "87654321" }).event?.sequence).toBe(1);
    emit(s, 4000, "working", {
      conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      url: "https://chatgpt.com/c/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(emit(s, 5000, "idle").event).toBeNull();
  });
  it("survives renderer restart and allows later genuine completions on the same turn", () => {
    const s = storage();
    emit(s, 1000, "working");
    // Storage survives; the observer module/state does not need a mounted React component.
    emit(s, 2000, "idle");
    const first = emit(s, 2800, "idle").event!;
    expect(first.sequence).toBe(1);
    emit(s, 3000, "working"); // User pressed regenerate on same turn.
    emit(s, 4000, "idle", { contentHash: "87654321" });
    const second = emit(s, 4800, "idle", { contentHash: "87654321" }).event!;
    expect(second.sequence).toBe(2);
    expect(first.eventId).not.toBe(second.eventId);
  });
  it("does not notify when persistence is unavailable or the page URL is wrong", () => {
    const bad = {
      getItem: () => null,
      setItem: () => {
        throw new Error("Quota");
      },
    };
    expect(observeChatGPTIdleSnapshot(env, sid, null, snap(1000, "working"), bad).event).toBeNull();
    const s = storage();
    expect(
      emit(s, 1000, "working", { url: "https://other.example/c/" + conversation }).event,
    ).toBeNull();
    expect(s.dump()).toHaveLength(0);
  });
});
