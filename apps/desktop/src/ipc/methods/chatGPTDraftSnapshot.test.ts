// @effect-diagnostics nodeBuiltinImport:off -- Isolated private snapshot/restore fixtures only.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  makePrivateDraftRecord,
  savePrivateChatGPTDraftSnapshot,
  verifyPrivateDraftRecord,
  type PrivateDraftRecord,
} from "./chatGPTDraftSnapshot.ts";

const payload = {
  sessionId: "b5fc0249-28e7-48c6-9591-6761b3fa3748",
  url: "https://chatgpt.com/c/6ad81f45-bd10-83ed-8128-6a3d584c876c",
  draft: "UNSENT offline fixture\n🌲",
  uncertainSend: {
    text: "Pending fixture",
    original: "Pending fixture",
    url: "https://chatgpt.com/c/6ad81f45-bd10-83ed-8128-6a3d584c876c",
    before: { totalTurns: 10, lastUserTurnKey: "prior-fixture" },
    policyEnrichment: {
      schema: "t3-c05-browser-optional/v1" as const,
      status: "prepared" as const,
    },
  },
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("private ChatGPT draft and UNKNOWN-send snapshot", () => {
  it("writes one isolated UUID-scoped record, verifies offline restore and returns metadata only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t3-draft-fixture-"));
    roots.push(root);
    const receipt = await savePrivateChatGPTDraftSnapshot(payload, root);
    expect(receipt).toMatchObject({
      sessionId: payload.sessionId,
      url: payload.url,
      uncertainSendPresent: true,
    });
    expect(receipt.bytes).toBe(Buffer.byteLength(payload.draft, "utf8"));
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(payload.draft);
    expect(JSON.stringify(receipt)).not.toContain(payload.uncertainSend.text);
    const restored = JSON.parse(await readFile(receipt.path, "utf8")) as PrivateDraftRecord;
    expect(verifyPrivateDraftRecord(restored)).toBe(true);
    expect(restored.payload.draft).toBe(payload.draft);
    expect(restored.payload.uncertainSend?.original).toBe(payload.uncertainSend.original);
    // A changed byte, role/URL identity or pending-send field must fail offline proof.
    expect(
      verifyPrivateDraftRecord({
        ...restored,
        payload: { ...restored.payload, draft: "tampered" },
      }),
    ).toBe(false);
    expect(
      verifyPrivateDraftRecord({
        ...restored,
        payload: { ...restored.payload, sessionId: "other" },
      }),
    ).toBe(false);
  });

  it("never claims that an absent draft/uncertain send is a recovered legacy draft", () => {
    const empty = { ...payload, draft: "", uncertainSend: null };
    const record = makePrivateDraftRecord(empty, "2026-10-23T00:00:00.000Z");
    expect(verifyPrivateDraftRecord(record)).toBe(true);
    expect(record.payload.uncertainSend).toBeNull();
    expect(record.payload.draft).toBe("");
  });
});
