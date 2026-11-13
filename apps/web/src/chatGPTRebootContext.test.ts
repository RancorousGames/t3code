// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { buildChatGPTRebootContextPrompt } from "./chatGPTRebootContext";

const previous = [
  { role: "user", text: "Please fix the spear cursor bug" },
  { role: "assistant", text: "I wrongly assumed this is solved (unverified)" },
  { role: "user", text: "Please measure actual contact height" },
] as const;

describe("reboot context isolation", () => {
  it("retains provenance and recent progress for keep context", () => {
    const prompt = buildChatGPTRebootContextPrompt({
      mode: "handoff", title: "Spear work", project: "Wartribes",
      opening: previous, recent: previous,
    });
    expect(prompt).toContain("Please measure actual contact height");
    expect(prompt).toContain("I wrongly assumed this is solved");
    expect(prompt).toContain("NOT verified facts");
    expect(prompt).toContain("Wartribes");
  });

  it("discards predecessor reasoning but preserves original assignment on fresh start", () => {
    const prompt = buildChatGPTRebootContextPrompt({
      mode: "fresh", title: "Spear work", project: "Wartribes",
      opening: previous, recent: previous,
    });
    expect(prompt).toContain("Please fix the spear cursor bug");
    expect(prompt).not.toContain("wrongly assumed");
    expect(prompt).not.toContain("measure actual contact");
  });

  it("uses TaskBoard as authority and omits predecessor messages for fresh assigned workers", () => {
    const prompt = buildChatGPTRebootContextPrompt({
      mode: "fresh", title: "Worker", role: "worker",
      taskRef: { board: "B:/tasks", id: "T3-0099" },
      opening: previous, recent: previous,
    });
    expect(prompt).toContain("T3-0099");
    expect(prompt).not.toContain("spear");
  });
});
