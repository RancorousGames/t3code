import { describe, expect, it } from "vite-plus/test";
import { parseTaskBoardClaim } from "./taskBoardWorkerClaims.ts";

describe("TaskBoard worker claims", () => {
  it("parses exact claimed UUID, Done and completed timestamp from Markdown frontmatter", () => {
    const task = parseTaskBoardClaim(`---
kind: task
id: T3-0063
column: done
claimed_by: 8592f5c8-c022-4a92-bd3b-008556fa0339
completed_at: 2026-10-25T11:01:13.402972800Z
---
## AI Notes
column: in-progress`);
    expect(task).toEqual({
      taskId: "T3-0063",
      claimedBy: "8592f5c8-c022-4a92-bd3b-008556fa0339",
      column: "done",
      completedAt: Date.parse("2026-10-25T11:01:13.402Z"),
    });
  });
  it("does not infer completion from notes or non-UUID claims", () => {
    expect(
      parseTaskBoardClaim("---\nid: T3-1234\ncolumn: done\nclaimed_by: manager\n---"),
    ).toBeNull();
    expect(parseTaskBoardClaim("## AI Notes\ncolumn: done")).toBeNull();
    expect(
      parseTaskBoardClaim(
        "---\nid: T3-1234\ncolumn: in-progress\nclaimed_by: 8592f5c8-c022-4a92-bd3b-008556fa0339\n---",
      )?.column,
    ).toBe("in-progress");
  });
});
