import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "../chatGPTBrowserSessions";
import { chatGPTRestartWorkingSessions, CHATGPT_RESTART_WORKING_GRACE_MS } from "./chatGPTRestartWorkingSessions";

const now = 100000000;
const validUrl = "https://chatgpt.com/c/c4096408-b6b6-4653-a6a8-baa53a4cedc7";
const id = "c4096408-b6b6-4653-a6a8-baa53a4cedc7";
const session = (id: string, fields: Partial<BrowserSession> = {}) => ({ id, title: id, ...fields }) as BrowserSession;
const working = (observedAt = now - 1000) => ({
  observedAt, url: validUrl, conversationId: id, activity: "working",
  signals: { stopButton: true, draftPresent: false, signInOrCaptcha: false },
});
describe("restart working-session mount safety", () => {
  it("remounts a freshly working guest without requesting any send", () => {
    const eligible = chatGPTRestartWorkingSessions([session("active")], { active: working() }, now);
    expect([...eligible]).toEqual(["active"]);
  });
  it("rejects stale, idle, stale-conversation and incomplete observations", () => {
    const rows = ["old", "idle", "badurl", "nostop", "future"].map((id) => session(id));
    const result = chatGPTRestartWorkingSessions(rows, {
      old: working(now - CHATGPT_RESTART_WORKING_GRACE_MS - 1),
      idle: { ...working(), activity: "idle" },
      badurl: { ...working(), conversationId: "wrong" },
      nostop: { ...working(), signals: { ...working().signals, stopButton: false } },
      future: working(now + 1000),
    }, now);
    expect([...result]).toEqual([]);
  });
  it("does not remount hidden, snoozed, unconfirmed-send or draft owners", () => {
    const rows = [
      session("hidden", { hidden: true }),
      session("parked", { snoozedUntil: now + 3000 }),
      session("unknown"),
      session("draft"),
    ];
    const result = chatGPTRestartWorkingSessions(rows, {
      hidden: working(), parked: working(), unknown: working(),
      draft: { ...working(), signals: { ...working().signals, draftPresent: true } },
    }, now, new Set(["unknown"]));
    expect([...result]).toEqual([]);
  });
});
