import { assert, describe, it } from "vite-plus/test";

import {
  buildPrepfileHandoffInstruction,
  buildPrepfileInstruction,
  type PendingPrepfileHandoff,
} from "./prepfileFlow";

describe("prepfile TaskBoard handoff", () => {
  it("requires task creation before the final handoff file and binds the implementer to its task", () => {
    const prep = buildPrepfileInstruction({
      request: "Fix the buttons",
      outputPath: "E:\\_AgentScratch\\Unassigned\\Prepfile\\Deliverables\\prepfile-example.md",
      depth: "medium",
      hasAutomaticHandoff: true,
      createTaskboardTask: true,
    });
    assert.ok(prep.indexOf("before writing the final prepfile") < prep.indexOf("Create the destination folder"));
    assert.match(prep, /exact task ID and owning board root/);

    const job = {
      id: "job",
      environmentId: "env",
      projectId: "project",
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      outputPath: "E:\\_AgentScratch\\prepfile.md",
      request: "Fix the buttons",
      createdAt: 1,
      state: "dispatching",
      createTaskboardTask: true,
      targetThreadId: "cf98e287-e8d7-4f1d-baf1-020111f24267",
    } as PendingPrepfileHandoff;
    const handoff = buildPrepfileHandoffInstruction(job);
    assert.match(handoff, /claim that task before implementing/);
    assert.match(handoff, /t3:cf98e287-e8d7-4f1d-baf1-020111f24267/);
    assert.doesNotMatch(buildPrepfileHandoffInstruction({
      ...job, createTaskboardTask: false,
    }), /claim that task/);
  });
});
