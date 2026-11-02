// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Real filesystem lifecycle test for the isolated idle journal.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { ChatGPTIdleTransitionJournal } from "./ChatGPTIdleTransitionJournal.ts";

const sid = "11111111-1111-4111-8111-111111111111";
const cid = "22222222-2222-4222-8222-222222222222";
const event = (sequence: number) => ({
  environmentId: "local",
  sessionId: sid,
  conversationId: cid,
  bindingRevision: "bound-revision-1",
  sequence,
  eventId: `${sid}:${cid}:${sequence}`,
  observedAt: Date.now() + sequence,
  turnCount: sequence,
});

describe("ChatGPT idle journal", () => {
  it("persists an exact event across restart without replaying duplicates", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-idle-"));
    try {
      const first = new ChatGPTIdleTransitionJournal(dir);
      const one = event(1);
      expect(first.record(one)).toBe(true);
      expect(first.record(one)).toBe(false);
      const recovered = new ChatGPTIdleTransitionJournal(dir);
      expect(recovered.get("local", sid)?.eventId).toBe(one.eventId);
      expect(recovered.record(event(0))).toBe(false);
      expect(recovered.record(event(2))).toBe(true);
      expect(recovered.get("local", sid)?.sequence).toBe(2);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notifies one exact listener without repeating old idle edges", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-idle-"));
    try {
      const journal = new ChatGPTIdleTransitionJournal(dir);
      journal.record(event(1));
      const waiting = journal.wait("local", sid, 1, 500);
      journal.record(event(2));
      expect((await waiting)?.sequence).toBe(2);
      expect((await journal.wait("local", sid, 1, 10))?.sequence).toBe(2);
      expect(await journal.wait("other", sid, 0, 10)).toBeNull();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
