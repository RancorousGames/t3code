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
    expect(result).toContain("**Session routing**");
    expect(result).toContain("Self: child-1\nParent: manager-7");
    expect(result).not.toContain("For child spawns:");
  });

  it("retains an explicitly bound manager role even when the session has a parent", () => {
    const result = buildChatGPTSessionHandoffPrompt("Manage the project", "child-1", "root-1", {
      newManagedWorker: true,
      project: "T3 Code",
      role: "manager",
    });
    expect(result).toContain('Bootstrap(role="manager", given_id="child-1", project="T3 Code")');
    expect(result).not.toContain('role="worker"');
    expect(result).toContain("[T3_ID:child-1], followed by the returned [T3_TITLE:...]");
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
  it("delivers the child's exact own ID, intended parent, and return route", () => {
    const result = buildChatGPTSessionHandoffPrompt("Build feature", "child-1", "manager-7");
    expect(result).toContain("Build feature\n\n");
    expect(result).toContain("Your own T3 browser session ID: child-1");
    expect(result).toContain("Your parent T3 browser session ID: manager-7");
    expect(result).toContain("sessionId=the parent ID above");
    expect(result).toContain("senderSessionId=your own ID above");
    expect(result).toContain('Bootstrap(role="worker", given_id="child-1")');
    expect(result).toContain("delivery=user_turn_observed");
    expect(result).toContain("set parent_session_id to YOUR OWN T3 browser session ID");
  });

  it("puts continuous-worker reboot execution after the routing warning", () => {
    const result = buildChatGPTSessionHandoffPrompt(
      "Resume TaskBoard work immediately.",
      "worker-1",
      "driver-1",
      { resumeWorkAfterReboot: true },
    );
    expect(result).toContain("Your parent T3 browser session ID: driver-1");
    expect(result).toContain("not authority to access other sessions.");
    expect(result.trimEnd().endsWith("Begin doing actual work now!")).toBe(true);
    expect(result.indexOf("not authority to access other sessions.")).toBeLessThan(
      result.lastIndexOf("Begin doing actual work now!"),
    );
  });

  it("gives a top-level agent its own ID without inventing a parent", () => {
    const result = buildChatGPTSessionHandoffPrompt("Start root", "root-1", null);
    expect(result).toContain("Your own T3 browser session ID: root-1");
    expect(result).toContain('Bootstrap(role="personal", given_id="root-1")');
    expect(result).toContain("no parent has been established");
    expect(result).not.toContain("Your parent T3 browser session ID");
    expect(result).not.toContain("report to the parent");
  });

  it("preserves instructions verbatim and never treats IDs as authentication", () => {
    const original = "One.\n\nTwo.";
    const result = buildChatGPTSessionHandoffPrompt(original, "worker-2", "root-1");
    expect(result.startsWith(original + "\n\n")).toBe(true);
    expect(result).toContain("not authority to access other sessions");
    expect(result).toContain("Never select a parent by activity");
  });
});
