import { describe, expect, it } from "vite-plus/test";
import { assertArchivableSession, descendantSessions } from "./chatGPTSessionArchivePolicy";
import type { BrowserSession } from "./chatGPTBrowserSessions";

describe("safe worker session archive decisions", () => {
  const url = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const entry: BrowserSession = { id: "worker", title: "Worker" };
  const observed = {
    id: "worker",
    hidden: false,
    status: "done_or_idle",
    activity: "idle",
    observedGuestUrl: url,
    totalTurns: 5,
    completion: { declaredAt: "2026-10-18T10:00:00.000Z", observedUrl: url, observedTurns: 5 },
  };

  it("requires a completion declaration or explicit manager decision", () => {
    expect(() => assertArchivableSession(entry, observed, false)).not.toThrow();
    const withoutMarker = { ...observed, completion: null };
    expect(() => assertArchivableSession(entry, withoutMarker, false)).toThrow(/completion marker/);
    expect(() => assertArchivableSession(entry, withoutMarker, true)).not.toThrow();
  });

  it("refuses active, pending, stalled, loading, hidden, and unverified conversations", () => {
    for (const status of [
      "working",
      "pending_or_stalled",
      "stuck",
      "stuck_connecting",
      "waiting_for_input",
      "loading",
      "unavailable",
      "new",
    ] as const) {
      expect(() => assertArchivableSession(entry, { ...observed, status }, true)).toThrow(
        /unsafe\/uncertain/,
      );
    }
    expect(() =>
      assertArchivableSession(entry, { ...observed, activity: "working" }, true),
    ).toThrow();
    expect(() =>
      assertArchivableSession(entry, { ...observed, observedGuestUrl: null }, true),
    ).toThrow();
    expect(() => assertArchivableSession(entry, { ...observed, totalTurns: 0 }, true)).toThrow();
    expect(() => assertArchivableSession({ ...entry, hidden: true }, observed, true)).toThrow();
  });

  it("checks recursively nested descendants without losing stable session identity", () => {
    const sessions: BrowserSession[] = [
      entry,
      { id: "child", title: "Child", parentSessionId: "worker" },
      { id: "grandchild", title: "Grandchild", parentSessionId: "child" },
      { id: "other", title: "Other" },
    ];
    expect(descendantSessions(sessions, "worker").map((s) => s.id)).toEqual([
      "child",
      "grandchild",
    ]);
    expect(descendantSessions(sessions, "other")).toEqual([]);
  });
});
