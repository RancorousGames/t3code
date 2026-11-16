import { describe, expect, it } from "vite-plus/test";
import { attentionPrioritySessionIds } from "./chatGPTAttentionPriority";

describe("GMA attention priority", () => {
  it("includes persistent marks and unresolved agent requests via public-ID alias", () => {
    const sessions = [
      { id: "persistent", title: "Marked", returnMarker: "armed" as const },
      { id: "agent", title: "Agent", bootstrapIdentity: { state: "registered" as const, publicId: "public-agent" } },
      { id: "done", title: "Resolved" },
      { id: "paused", title: "Snoozed" },
    ];
    const requests = [
      { id: "a", sessionId: "public-agent", message: "GMA", status: "waiting" as const, createdAt: 1, nextAt: 0 },
      { id: "b", sessionId: "done", message: "Finished", status: "opened" as const, createdAt: 1, nextAt: 0 },
      { id: "c", sessionId: "paused", message: "Snoozed", status: "snoozed" as const, createdAt: 1, nextAt: 100 },
    ];
    expect([...attentionPrioritySessionIds(sessions, requests)]).toEqual(["persistent", "agent"]);
  });
});
