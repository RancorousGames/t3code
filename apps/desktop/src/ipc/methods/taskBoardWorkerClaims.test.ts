import { describe, expect, it } from "vite-plus/test";
import { parseTaskBoardClaim } from "./taskBoardWorkerClaims.ts";

describe("TaskBoard worker associations", () => {
  it("reads exact UUID, Done and completed timestamp from frontmatter", () => {
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

  it("keeps legacy short-ID claims and unclaimed cards for title association", () => {
    expect(parseTaskBoardClaim(
      "---\nid: T3-0085\ncolumn: in-progress\nclaimed_by: T3-worker-67cbb8ca\n---",
    )).toEqual({
      taskId: "T3-0085", claimedBy: "t3-worker-67cbb8ca",
      column: "in-progress", completedAt: null,
    });
    expect(parseTaskBoardClaim("---\nid: T3-0088\ncolumn: ai-ready\n---")).toEqual({
      taskId: "T3-0088", claimedBy: "", column: "ai-ready", completedAt: null,
    });
  });

  it("does not infer completion from notes or untrusted text", () => {
    expect(parseTaskBoardClaim("## AI Notes\ncolumn: done")).toBeNull();
    expect(parseTaskBoardClaim("---\nid: invalid\ncolumn: done\n---")).toBeNull();
    expect(parseTaskBoardClaim(
      "---\nid: T3-1234\ncolumn: in-progress\nclaimed_by: manager\n---",
    )?.column).toBe("in-progress");
  });
});
