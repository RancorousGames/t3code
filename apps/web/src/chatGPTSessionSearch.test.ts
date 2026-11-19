import { describe, expect, it } from "vite-plus/test";

import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import {
  searchChatGPTSessionCatalog,
  searchChatGPTSessionGroups,
  searchChatGPTSessionHistory,
} from "./chatGPTSessionSearch";

const groups: ChatGPTSidebarGroup[] = [
  {
    key: "project:t3",
    title: "T3 Code",
    rows: [
      { session: { id: "parent", title: "Fix chat nesting" }, depth: 0, childCount: 1 },
      {
        session: { id: "child", title: "Smoke-test child", parentSessionId: "parent" },
        depth: 1,
        childCount: 0,
      },
      { session: { id: "other", title: "Improve search" }, depth: 0, childCount: 0 },
    ],
  },
  {
    key: "other",
    title: "Other",
    rows: [{ session: { id: "one", title: "Cascadeur smoke test" }, depth: 0, childCount: 0 }],
  },
  { key: "unused", title: "Unused", rows: [] },
];

describe("ChatGPT sidebar session search", () => {
  it("leaves original grouped sessions untouched when query is empty", () => {
    const result = searchChatGPTSessionGroups(groups, "  ");
    expect(result).toEqual(groups);
    expect(result[0]).toBe(groups[0]);
  });

  it("matches case-insensitive substrings, removes empty groups, and preserves order", () => {
    const result = searchChatGPTSessionGroups(groups, " SMOKE ");
    expect(result.map((group) => group.key)).toEqual(["project:t3", "other"]);
    expect(result[0]!.rows.map(({ session }) => session.id)).toEqual(["child"]);
    expect(result[1]!.rows.map(({ session }) => session.id)).toEqual(["one"]);
    expect(result[0]!.rows[0]!.depth).toBe(0);
  });

  it("finds all members by project heading even if none of their titles match", () => {
    const result = searchChatGPTSessionGroups(groups, "t3 CODE");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(groups[0]);
    expect(result[0]!.rows).toHaveLength(3);
  });

  it("preserves visible parent-child nesting when both match, without modifying saved data", () => {
    const result = searchChatGPTSessionGroups(groups, "ch");
    expect(result[0]!.rows.map(({ session }) => session.id)).toEqual(["parent", "child", "other"]);
    expect(result[0]!.rows.map(({ depth, childCount }) => ({ depth, childCount }))).toEqual([
      { depth: 0, childCount: 1 },
      { depth: 1, childCount: 0 },
      { depth: 0, childCount: 0 },
    ]);
    expect(groups[0]!.rows[0]!.childCount).toBe(1);
  });

  it("produces no groups for a miss", () => {
    expect(searchChatGPTSessionGroups(groups, "nothing matches")).toEqual([]);
  });
});

describe("full ChatGPT session catalog search", () => {
  const catalog = [
    { id: "regular", title: "Main session" },
    {
      id: "hidden-t3-guid",
      title: "Hidden one",
      hidden: true,
      bootstrapIdentity: {
        state: "registered" as const,
        publicId: "public-session-guid",
        conversationId: "chatgpt-conversation-guid",
      },
    },
    { id: "snooze-guid", title: "Snoozed one", snoozedUntil: 2000 },
    { id: "worker-guid", title: "Hidden worker" },
  ];

  it("searches hidden and snoozed and filtered worker records without showing unrelated sessions", () => {
    const results = searchChatGPTSessionCatalog({
      groups: [],
      sessions: catalog,
      query: "one",
      now: 1000,
      hiddenWorkerIds: new Set(["worker-guid"]),
    });
    expect(
      results.map((group) => [group.title, group.rows.map(({ session }) => session.id)]),
    ).toEqual([
      ["Hidden sessions", ["hidden-t3-guid"]],
      ["Snoozed sessions", ["snooze-guid"]],
    ]);
    const workerResults = searchChatGPTSessionCatalog({
      groups: [],
      sessions: catalog,
      query: "worker-guid",
      now: 1000,
      hiddenWorkerIds: new Set(["worker-guid"]),
    });
    expect(workerResults[0]?.title).toBe("Hidden workers");
  });

  it("finds both T3 public IDs and ChatGPT conversation IDs and avoids duplicate visible hits", () => {
    for (const query of ["hidden-t3-guid", "public-session-guid", "chatgpt-conversation-guid"]) {
      expect(
        searchChatGPTSessionCatalog({
          groups: [],
          sessions: catalog,
          query,
          now: 1000,
        })[0]?.rows.map(({ session }) => session.id),
      ).toEqual(["hidden-t3-guid"]);
    }
    const groupsWithRegular: ChatGPTSidebarGroup[] = [
      {
        key: "main",
        title: "Main",
        rows: [{ session: catalog[0]!, depth: 0, childCount: 0 }],
      },
    ];
    expect(
      searchChatGPTSessionCatalog({
        groups: groupsWithRegular,
        sessions: catalog,
        query: "main",
        now: 1000,
      })
        .flatMap((group) => group.rows)
        .map(({ session }) => session.id),
    ).toEqual(["regular"]);
  });
});

describe("historical ChatGPT session search", () => {
  const workerId = "b21c8731-b29b-46d6-b7af-1876e3a8ddda";
  const chatId = "6afe9e38-20e4-83eb-9254-5cf6fdb531ec";
  const registry = [
    {
      environmentId: "local",
      sessionId: "internal-browser-worker",
      publicSessionId: workerId,
      record: {
        id: "internal-browser-worker",
        title: "G-05 and G-08 animation worker",
        bootstrapIdentity: { state: "registered", publicId: workerId, conversationId: chatId },
      },
      snapshot: null,
      timeline: null,
      metadataRevision: 0,
      metadataPatch: {},
      closedAt: 1795100000000,
      updatedAt: 1795100000000,
    },
  ];

  it("locates a closed worker by its public T3 GUID even after its browser session was removed", () => {
    const results = searchChatGPTSessionHistory({
      sessions: [],
      registry,
      removals: [],
      query: workerId.toUpperCase(),
    });
    expect(results).toEqual([
      {
        id: workerId,
        title: "G-05 and G-08 animation worker",
        status: "closed",
        conversationUrl: `https://chatgpt.com/c/${chatId}`,
      },
    ]);
  });

  it("does not duplicate live hidden or snoozed sessions, including unloaded browser guests", () => {
    const results = searchChatGPTSessionHistory({
      sessions: [
        {
          id: "internal-browser-worker",
          title: "G-05 and G-08 animation worker",
          hidden: true,
          snoozedUntil: 1795200000000,
        },
      ],
      registry,
      removals: [],
      query: workerId,
    });
    expect(results).toEqual([]);
  });

  it("falls back to the local close journal when the registry is offline", () => {
    expect(
      searchChatGPTSessionHistory({
        sessions: [],
        registry: [],
        removals: [{ sessionId: workerId, title: "Historic G-08 worker", conversationId: null }],
        query: "b21c8731",
      }),
    ).toEqual([
      {
        id: workerId,
        title: "Historic G-08 worker",
        status: "closed",
        conversationUrl: null,
      },
    ]);
  });
});
