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
    expect(prompt).toContain("not verified");
    expect(prompt).toContain("Wartribes");
  });

  it("requires the actual indexed document path for multi-generation handover", () => {
    const prompt = buildChatGPTRebootContextPrompt({
      mode: "handoff", title: "Pose work",
      originalRequest: "Create pose reference images",
      historyDocument: { path: "E:/_AgentScratch/Reboot/history.txt", generations: 7, messages: 143, limited: false },
      recent: [{ role: "user", text: "[T3-MSG:e39416df-1d75-49c7-9c16-ac47eae06b4f] Continue working on your current assignment." }],
    });
    expect(prompt).toContain("E:/_AgentScratch/Reboot/history.txt");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("7 indexed ChatGPT conversations");
    expect(prompt).toContain("FIRST ACTION");
    expect(prompt).not.toContain("Recent substantive requests/progress");
    expect(prompt).not.toContain("T3-MSG");
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
