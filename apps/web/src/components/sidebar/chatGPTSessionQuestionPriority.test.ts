import { describe, expect, it } from "vite-plus/test";
import { prioritizePendingChatGPTQuestions } from "./chatGPTSessionQuestionPriority";
import type { BrowserSession } from "../../chatGPTBrowserSessions";

describe("pending ChatGPT question sidebar priority", () => {
  it("places even hidden sessions at the top exactly once", () => {
    const a = { id: "a", title: "Worker", hidden: true } as BrowserSession;
    const b = { id: "b", title: "Manager" } as BrowserSession;
    const original = [{ key: "active", title: "Active", rows: [
      { session: b, depth: 0, childCount: 0 },
      { session: a, depth: 0, childCount: 0 },
    ] }];
    const result = prioritizePendingChatGPTQuestions(original, [a,b], new Set(["a"]));
    expect(result[0]?.key).toBe("status:questions");
    expect(result[0]?.rows.map(row => row.session.id)).toEqual(["a"]);
    expect(result[1]?.rows.map(row => row.session.id)).toEqual(["b"]);
    expect(original[0]?.rows).toHaveLength(2);
  });
});
