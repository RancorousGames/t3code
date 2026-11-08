import { describe, expect, it } from "vite-plus/test";
import { layoutChatGPTSessions } from "./chatGPTSessionGrouping";
import {
  snapshotChatGPTActivityOrder,
  stabilizeChatGPTActivityOrder,
} from "./chatGPTActivityOrderStability";

describe("ChatGPT sidebar activity order stability", () => {
  const now = 2_000_000_000;
  const sessions = [
    { id: "a", title: "Alpha", project: "Alpha" },
    { id: "b", title: "Bravo", project: "Bravo" },
    { id: "c", title: "Charlie", project: "Charlie" },
  ];
  const ids = (groups: ReturnType<typeof layoutChatGPTSessions>) =>
    groups.flatMap((group) => group.rows.map(({ session }) => session.id));

  it("does not reshuffle idle guests on recent/unloaded transitions or timestamp refreshes", () => {
    const initial = {
      a: { age: "recent" as const, lastWorkingAt: now - 1_000 },
      b: { age: "unloaded-recent" as const, lastWorkingAt: now - 2_000 },
      c: { age: "inactive" as const, lastWorkingAt: now - 3_000 },
    };
    const previous = snapshotChatGPTActivityOrder(
      layoutChatGPTSessions(sessions, [], "activity", initial, [], undefined, true, now),
      "activity", initial,
    );
    const observed = {
      a: { age: "unloaded" as const, lastWorkingAt: now - 4_000 },
      b: { age: "inactive" as const, lastWorkingAt: now - 200 },
      c: { age: "unloaded-recent" as const, lastWorkingAt: now - 2_500 },
    };
    const raw = layoutChatGPTSessions(sessions, [], "activity", observed, [], undefined, true, now);
    expect(ids(raw)).toEqual(["b", "c", "a"]);
    expect(ids(stabilizeChatGPTActivityOrder(raw, previous, "activity", observed)))
      .toEqual(["a", "b", "c"]);
  });

  it("still promotes a directly used guest and one that starts working", () => {
    const initial = {
      a: { age: "recent" as const, lastWorkingAt: now - 1_000 },
      b: { age: "unloaded" as const, lastWorkingAt: now - 2_000 },
      c: { age: "inactive" as const, lastWorkingAt: now - 3_000 },
    };
    const previous = snapshotChatGPTActivityOrder(
      layoutChatGPTSessions(sessions, [], "activity", initial, [], undefined, true, now),
      "activity", initial,
    );
    const clicked = sessions.map((session) =>
      session.id === "c" ? { ...session, lastDirectInteractionAt: now - 10 } : session,
    );
    const interacted = layoutChatGPTSessions(clicked, [], "activity", initial, [], undefined, true, now);
    expect(ids(stabilizeChatGPTActivityOrder(interacted, previous, "activity", initial)))
      .toEqual(["c", "a", "b"]);

    const working = { ...initial, b: { age: "working" as const, lastWorkingAt: now } };
    const active = layoutChatGPTSessions(sessions, [], "activity", working, [], undefined, true, now);
    expect(ids(stabilizeChatGPTActivityOrder(active, previous, "activity", working)))
      .toEqual(["b", "a", "c"]);
  });

  it("accepts a new grouping context rather than forcing stale positions", () => {
    const activity = {
      a: { age: "recent" as const, lastWorkingAt: now - 1_000 },
      b: { age: "recent" as const, lastWorkingAt: now - 2_000 },
      c: { age: "recent" as const, lastWorkingAt: now - 3_000 },
    };
    const groups = layoutChatGPTSessions(sessions, [], "activity", activity, [], undefined, true, now);
    const previous = snapshotChatGPTActivityOrder(groups, "old-filter", activity);
    expect(stabilizeChatGPTActivityOrder(groups, previous, "changed-filter", activity)).toEqual(groups);
  });
});
