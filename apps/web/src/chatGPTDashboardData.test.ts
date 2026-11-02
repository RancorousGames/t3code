import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";
import { groupChatGPTDashboardSessions, projectChatGPTDashboardSession } from "./chatGPTDashboardData";

const NOW = new Date("2026-10-29T20:00:00.000Z").getTime();
const session = (id: string, extra: Partial<BrowserSession> = {}) =>
  ({ id, title: id, createdAt: NOW - 600_000, ...extra }) as BrowserSession;
const snapshot = (activity: ChatGPTPageSnapshot["activity"], observedAt = NOW - 1_000) => ({
  observedAt,
  activity,
  url: "https://chatgpt.com/c/9c4869a5-72f2-4bf2-9154-409182347660",
  conversationId: "9c4869a5-72f2-4bf2-9154-409182347660",
  signals: {
    stopButton: activity === "working", interruptedBanner: false, loadError: false,
    composerPresent: true, draftPresent: false, signInOrCaptcha: false,
    conversationFull: false,
  },
  turnCount: 8,
  lastAssistant: { text: "Ready", truncated: false, endsWithQuestion: false },
  contentHash: "1234abcd",
}) satisfies ChatGPTPageSnapshot;

describe("ChatGPT dashboard read-only projections", () => {
  it("shows a fresh working snapshot, but never presents yesterday's green state as live", () => {
    const fresh = projectChatGPTDashboardSession({ session: session("a"), snapshot: snapshot("working"), now: NOW });
    expect(fresh.model.activity).toBe("working");
    const stale = projectChatGPTDashboardSession({
      session: session("a"), snapshot: snapshot("working", NOW - 60 * 60_000), now: NOW,
    });
    expect(stale.model.activity).toBe("unknown");
    expect(stale.snapshot?.lastAssistant?.text).toBe("Ready"); // Cache retained, never discarded.
    expect(stale.updatedAt).toBe(NOW - 60 * 60_000);
  });

  it("preserves UNKNOWN-send priority over a page question", () => {
    const observed = snapshot("idle");
    const row = projectChatGPTDashboardSession({
      session: session("blocked"), snapshot: { ...observed,
        lastAssistant: { text: "Question?", truncated: false, endsWithQuestion: true },
      }, now: NOW, uncertainSend: true,
    });
    expect(row.model.attention).toBe("unconfirmed_send");
    expect(row.model.primaryAction).toBe("check_delivery");
    expect(row.model.bucket).toBe("needs_you");
  });

  it("keeps snoozed out of needs-you and completed-today only with a bound observed conversation", () => {
    const parked = projectChatGPTDashboardSession({
      session: session("parked", { snoozedUntil: NOW + 5_000 }),
      snapshot: snapshot("idle"), now: NOW,
    });
    const completed = projectChatGPTDashboardSession({
      session: session("complete", {
        completion: { declaredAt: new Date(NOW).toISOString(),
          observedTurns: 8, observedUrl: snapshot("idle").url },
      }),
      snapshot: snapshot("idle"), now: NOW,
    });
    const groups = groupChatGPTDashboardSessions([parked, completed], NOW);
    expect(groups.snoozed.map((row) => row.session.id)).toEqual(["parked"]);
    expect(groups.completed.map((row) => row.session.id)).toEqual(["complete"]);
    expect(groups.working).toEqual([]);
  });
});
