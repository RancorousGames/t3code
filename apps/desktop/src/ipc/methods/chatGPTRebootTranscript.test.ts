// @vitest-environment node
// @effect-diagnostics nodeBuiltinImport:off
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { prepareChatGPTRebootTranscript, selectRebootHistory } from "./chatGPTRebootTranscript.ts";

vi.mock("electron", () => ({ app: { getPath: () => "C:/unused" } }));
vi.mock("../DesktopIpc.ts", () => ({ makeIpcMethod: () => ({}) }));

const SESSION = "f1a453af-fdc4-46ff-8a16-cae8cbe636ae";
const OP = "bc4c0ccb-b1a4-4666-a92c-69b50dfc52d0";
const WAKE = "[T3-MSG:e39416df-1d75-49c7-9c16-ac47eae06b4f] Continue working on your current assignment. If everything is genuinely finished, stop Caffy.";

describe("archived reboot transcript document", () => {
  it("does not mistake Caffy pings or old reboot prompts for original assignments", () => {
    const selected = selectRebootHistory([
      { conversation_id: "old", url: "https://chatgpt.com/c/old", title: null, first_seen: "2026-01-01",
        role: "user", turn_index: 0, ordinal: 0, text: WAKE, possibly_truncated: 0 },
      { conversation_id: "old", url: "https://chatgpt.com/c/old", title: null, first_seen: "2026-01-01",
        role: "user", turn_index: 1, ordinal: 1, text: "Make standing grapple poses", possibly_truncated: 0 },
      { conversation_id: "new", url: "https://chatgpt.com/c/new", title: null, first_seen: "2026-01-02",
        role: "user", turn_index: 0, ordinal: 0, text: "Reboot mode: KEEP CONTEXT.\nmore text", possibly_truncated: 0 },
    ]);
    expect(selected.originalUserRequest).toBe("Make standing grapple poses");
    expect(selected.document).not.toContain(WAKE);
    expect(selected.generations).toBe(2);
  });

  it("writes a readable document of earlier generations; fresh gets only the first request", async () => {
    const base = existsSync("E:/_AgentScratch/Unassigned")
      ? "E:/_AgentScratch/Unassigned/T3Reboot/Temporary" : tmpdir();
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(path.join(base, "test-export-"));
    try {
      const db = new DatabaseSync(path.join(root, "index.sqlite"));
      db.exec("CREATE TABLE chatgpt_conversations (conversation_id TEXT, url TEXT, last_title TEXT, last_seen_at TEXT)");
      db.exec("CREATE TABLE chatgpt_messages (conversation_id TEXT, session_id TEXT, last_seen_at TEXT, role TEXT, turn_index INT, ordinal INT, text TEXT, possibly_truncated INT)");
      const addConversation = db.prepare("INSERT INTO chatgpt_conversations VALUES (?,?,?,?)");
      const add = db.prepare("INSERT INTO chatgpt_messages VALUES (?,?,?,?,?,?,?,?)");
      addConversation.run("old", "https://chatgpt.com/c/old", "Pose work", "2026-11-01");
      addConversation.run("new", "https://chatgpt.com/c/new", "Pose work", "2026-11-02");
      add.run("old", SESSION, "2026-11-01", "user", 0, 0, "Make grappling poses", 0);
      add.run("old", SESSION, "2026-11-01", "assistant", 0, 1, "Pose requirements collected", 0);
      add.run("new", SESSION, "2026-11-02", "user", 0, 0, WAKE, 0);
      add.run("new", SESSION, "2026-11-02", "user", 1, 1, "Check latest pose image", 0);
      db.close();

      const options = { databasePath: path.join(root, "index.sqlite"), destinationRoot: root };
      const handoff = await prepareChatGPTRebootTranscript({sessionId: SESSION, operationId: OP, mode: "handoff"}, options);
      expect(handoff.generations).toBe(2);
      expect(handoff.originalUserRequest).toBe("Make grappling poses");
      expect(readFileSync(handoff.path!, "utf8")).toContain("Pose requirements collected");
      expect(readFileSync(handoff.path!, "utf8")).toContain("Check latest pose image");
      const fresh = await prepareChatGPTRebootTranscript({
        sessionId: SESSION, operationId: "b7dac539-08c2-468f-864a-1a0b48a9a2b3", mode: "fresh",
      }, options);
      expect(fresh.path).toBeNull();
      expect(fresh.recent).toEqual([]);
      expect(fresh.originalUserRequest).toBe("Make grappling poses");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
