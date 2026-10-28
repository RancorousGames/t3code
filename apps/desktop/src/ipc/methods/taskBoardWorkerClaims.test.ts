// @effect-diagnostics nodeBuiltinImport:off -- Test fixture uses temporary filesystem.
import { describe, expect, it } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseTaskBoardClaim, readTaskBoardClaims } from "./taskBoardWorkerClaims.ts";

describe("TaskBoard worker associations", () => {
  it("validates current native review manifest and linked pending For User; ignores unrelated Draft", async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), "t3-worker-claims-"));
    const tasks = path.join(vault, "Example", "Tasks");
    const active = path.join(tasks, "Active");
    await fs.mkdir(active, { recursive: true });
    const makeCard = async (name: string, fields: string) =>
      fs.writeFile(path.join(active, name + ".md"),
        "---\nid: " + name + "\ncolumn: in-progress\n" + fields + "\n---\n");
    try {
      await makeCard("T3-0087", "claimed_by: worker-session");
      await makeCard("T3-0088", "claimed_by: worker-session");
      await makeCard("T3-0089", "claimed_by: worker-session");
      await makeCard("T3-0090", "claimed_by: worker-session\nattention:\n- question\nquestion:\n  prompt: Is this acceptable?");
      await makeCard("T3-0100", "kind: for_user\nrelated_to:\n- T3-0088\nattention:\n- question\nquestion:\n  prompt: Verify linked task");
      await fs.writeFile(path.join(active, "T3-0101.md"),
        "---\nid: T3-0101\nkind: for_user\ncolumn: draft\nrelated_to:\n- T3-0089\nattention:\n- question\nquestion:\n  prompt: unrelated draft\n---\n");
      const reviewDir = path.join(tasks, "Reviews", "T3-0087");
      await fs.mkdir(reviewDir, { recursive: true });
      await fs.writeFile(path.join(reviewDir, "manifest.json"),
        JSON.stringify({ task_id: "T3-0087", status: "open", rounds: [
          { number: 1, requested_at: "2026-10-26T10:00:00Z" },
        ] }));
      const claims = await readTaskBoardClaims(vault);
      const get = (id: string) => claims.find((claim) => claim.taskId === id)?.handoffAt;
      expect(get("T3-0087")).toBe(Date.parse("2026-10-26T10:00:00Z"));
      expect(get("T3-0088")).toBeGreaterThan(0);
      expect(get("T3-0089")).toBeNull();
      expect(get("T3-0090")).toBeGreaterThan(0);
      await fs.writeFile(path.join(reviewDir, "manifest.json"),
        JSON.stringify({ task_id: "T3-0087", status: "resolved", rounds: [
          { number: 1, requested_at: "2026-10-26T10:00:00Z" },
        ] }));
      expect((await readTaskBoardClaims(vault)).find((c) => c.taskId === "T3-0087")?.handoffAt)
        .toBeNull();
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
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
      handoffAt: null,
    });
  });

  it("keeps legacy short-ID claims and unclaimed cards for title association", () => {
    expect(parseTaskBoardClaim(
      "---\nid: T3-0085\ncolumn: in-progress\nclaimed_by: T3-worker-67cbb8ca\n---",
    )).toEqual({
      taskId: "T3-0085", claimedBy: "t3-worker-67cbb8ca",
      column: "in-progress", completedAt: null, handoffAt: null,
    });
    expect(parseTaskBoardClaim("---\nid: T3-0088\ncolumn: ai-ready\n---")).toEqual({
      taskId: "T3-0088", claimedBy: "", column: "ai-ready", completedAt: null, handoffAt: null,
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
