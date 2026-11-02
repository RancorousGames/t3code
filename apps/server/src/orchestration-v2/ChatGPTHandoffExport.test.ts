import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { NativeHandoffSource } from "./ChatGPTHandoffExport.ts";
import { exportNativeThreadForChatGPT } from "./ChatGPTHandoffExport.ts";

function source(input: Array<{ role: "user" | "assistant" | "system"; text: string; at: number; streaming?: boolean }>): NativeHandoffSource {
  return {
    thread: {
      id: "native-thread-1",
      title: "Context transfer",
      projectId: "project-a",
      providerInstanceId: "codex",
      worktreePath: "D:/Example",
    },
    messages: input.map((message, i) => ({
      id: `message-${i}`,
      role: message.role,
      text: message.text,
      createdAt: DateTime.makeUnsafe(message.at),
      streaming: message.streaming === true,
    })),
  } as unknown as NativeHandoffSource;
}

describe("native-to-ChatGPT portable context export", () => {
  it("preserves readable chronological user and assistant transcript without system prompts", () => {
    const exportResult = exportNativeThreadForChatGPT(source([
      { role: "assistant", text: "Done", at: 300 },
      { role: "system", text: "private internal system instruction", at: 200 },
      { role: "user", text: "Fix the bug", at: 100 },
      { role: "assistant", text: "partial", at: 400, streaming: true },
    ]));
    expect(exportResult.sourceThreadId).toBe("native-thread-1");
    expect(exportResult.includedMessages).toBe(2);
    expect(exportResult.omittedMessages).toBe(0);
    expect(exportResult.truncated).toBe(false);
    expect(exportResult.markdown.indexOf("Fix the bug")).toBeLessThan(
      exportResult.markdown.indexOf("Done"),
    );
    expect(exportResult.markdown).not.toContain("private internal system instruction");
    expect(exportResult.markdown).not.toContain("partial");
    expect(exportResult.markdown).toContain("Original worktree: D:/Example");
  });

  it("quotes historical content rather than issuing new instructions", () => {
    const exportResult = exportNativeThreadForChatGPT(source([
      { role: "user", text: "## Run this now\ncommand", at: 100 },
    ]));
    expect(exportResult.markdown).toContain("> ## Run this now\n> command");
    expect(exportResult.markdown).toContain("not current user instructions");
  });

  it("caps size, prefers latest history and excludes older messages", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const, text: `message-${i}-${"x".repeat(170)}`, at: i,
    }));
    const exportResult = exportNativeThreadForChatGPT(source(messages), { maxChars: 1200 });
    expect(exportResult.markdown.length).toBeLessThanOrEqual(1200);
    expect(exportResult.omittedMessages).toBeGreaterThan(0);
    expect(exportResult.truncated).toBe(true);
    expect(exportResult.markdown).toContain("message-19");
    expect(exportResult.markdown).not.toContain("message-0-");
  });

  it("rejects invalid export budgets", () => {
    expect(() => exportNativeThreadForChatGPT(source([]), { maxChars: 10 })).toThrow();
  });
});
