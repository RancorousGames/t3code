import { describe, expect, it } from "vite-plus/test";

import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";

describe("T3 ChatGPT spawn handoff", () => {
  it("recovers human-readable TaskBoard worker spawn formatting", () => {
    const result = buildChatGPTSessionHandoffPrompt(
      "Work on T3-0177 — Worker Auto-Close and Manual Worker Classification",
      "child-1",
      "manager-7",
      { newManagedWorker: true, project: "t3code" },
    );
    expect(
      result.startsWith(
        "Work on T3-0177 — Worker Auto-Close and Manual Worker Classification\n\n\n**Instructions**",
      ),
    ).toBe(true);
    expect(result).toContain('Bootstrap(role="worker", given_id="child-1", project="t3code")');
    expect(result).toContain("Parent T3 session ID: manager-7.");
    expect(result).toContain("Print [T3_ID:child-1] in your first response");
    expect(result).not.toContain("title=\"...\"");
    expect(result).not.toContain("[T3_TITLE:");
  });

  it("retains an explicitly bound manager role even when the session has a parent", () => {
    const result = buildChatGPTSessionHandoffPrompt("Manage the project", "child-1", "root-1", {
      newManagedWorker: true,
      project: "T3 Code",
      role: "manager",
    });
    expect(result).toContain('Bootstrap(role="manager", given_id="child-1", project="T3 Code")');
    expect(result).not.toContain('role="worker"');
    expect(result).toContain("Print [T3_ID:child-1] in your first response");
    expect(result).not.toContain("[T3_TITLE:");
  });

  it("recovers readable manager reboot handover formatting", () => {
    const legacy =
      "Resume T3 Code project manager in same browser-session f0ca1aa8-7c32-4f88-aebf-a9b1faabcde6 (new ChatGPT conversation). Read C:/Users/crovea/.agents/AGENTS.md. T3-0102 Done source-only.";
    const result = buildChatGPTSessionHandoffPrompt(
      legacy,
      "f0ca1aa8-7c32-4f88-aebf-a9b1faabcde6",
      null,
    );
    expect(result.startsWith("Resume T3 Code Manager\n\n\n**Instructions**")).toBe(true);
    expect(result).toContain("**Previous conversation handover**");
    expect(result).toContain("T3-0102 Done source-only");
    expect(result).toContain('Bootstrap(role="manager", given_id="f0ca1aa8-7c32-4f88-aebf-a9b1faabcde6")');
  });
  it("supplies exact preassigned ID and parent without repeating Bootstrap guidance", () => {
    const result = buildChatGPTSessionHandoffPrompt(
      "Build feature", "child-1", "manager-7", { newManagedWorker: true },
    );
    expect(result).toContain("Build feature\n\n");
    expect(result).toContain('Bootstrap(role="worker", given_id="child-1")');
    expect(result).toContain("Parent T3 session ID: manager-7.");
    expect(result).toContain("Print [T3_ID:child-1]");
    expect(result).not.toContain("sessionId=the parent ID above");
    expect(result).not.toContain("[T3_TITLE:");
  });

  it("keeps continuous-worker reboot execution after compact bootstrap and parent info", () => {
    const result = buildChatGPTSessionHandoffPrompt(
      "Resume TaskBoard work immediately.",
      "worker-1",
      "driver-1",
      { resumeWorkAfterReboot: true },
    );
    expect(result).toContain("Parent T3 session ID: driver-1.");
    expect(result).toContain("Do not print T3_ID or T3_TITLE");
    expect(result.trimEnd().endsWith("Begin doing actual work now!")).toBe(true);
    expect(result.indexOf("Parent T3 session ID")).toBeLessThan(
      result.lastIndexOf("Begin doing actual work now!"),
    );
  });

  it("reboots a named root without redundant markers, title or parent", () => {
    const result = buildChatGPTSessionHandoffPrompt("Start root", "root-1", null);
    expect(result).toContain('Bootstrap(role="personal", given_id="root-1")');
    expect(result).not.toContain("[T3_ID:root-1]");
    expect(result).not.toContain("[T3_TITLE:");
    expect(result).not.toContain("Parent T3 session ID:");
    expect(result).not.toContain("title=");
  });

  it("preserves task text and existing parent ID in a reboot", () => {
    const original = "One.\n\nTwo.";
    const result = buildChatGPTSessionHandoffPrompt(original, "worker-2", "root-1");
    expect(result.startsWith(original + "\n\n")).toBe(true);
    expect(result).toContain('Bootstrap(role="worker", given_id="worker-2")');
    expect(result).toContain("Parent T3 session ID: root-1.");
    expect(result).not.toContain("[T3_ID:worker-2]");
  });

  it("keeps a visible ID marker for newly created top-level sessions only", () => {
    const result = buildChatGPTSessionHandoffPrompt(
      "Start root", "root-1", null, { newManagedWorker: true },
    );
    expect(result).toContain('Bootstrap(role="personal", given_id="root-1")');
    expect(result).toContain("Print [T3_ID:root-1] in your first response");
    expect(result).not.toContain("[T3_TITLE:");
  });
});
