// @effect-diagnostics nodeBuiltinImport:off -- Cross-check canonical OpenRig SHA-256 receipt fixtures.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  postOpenRigOperatorReply,
  lookupOpenRigOperatorReply,
  fetchOpenRigOperatorInbox,
} from "./openRig.ts";

const input = {
  sourceType: "queue" as const,
  qitemId: "qitem-original-123",
  destination: "human@kernel" as const,
  expectedRecipient: "manager@omni",
  requestId: "11111111-1111-4111-9111-111111111111",
  message: "Acknowledged: proceed.",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const replyQitemId =
  "qitem-t3-operator-reply-" + hash(JSON.stringify([input.qitemId, input.requestId])).slice(0, 40);
const receipt = {
  outcome: "accepted",
  version: 1,
  qitemId: input.qitemId,
  replyQitemId,
  source: "human@kernel",
  recipient: input.expectedRecipient,
  messageSha256: hash(input.message),
  acceptedIntoQueue: true,
  deliveredToAgent: false,
  status: "recorded",
  delivery: "queued",
};
const inbox = {
  available: true,
  address: "human@kernel",
  addresses: [{ address: "human@kernel", label: "Local operator" }],
  count: 1,
  truncated: false,
  pendingCount: 0,
  answerWriteAvailable: false,
  replyWriteAvailable: true,
  items: [
    {
      id: input.qitemId,
      sender: input.expectedRecipient,
      recipient: "human@kernel",
      subject: "status",
      body: "Please reply",
      createdAt: "2026-10-23T12:00:00Z",
      state: "pending",
      requiresAction: false,
      attentionKind: "message",
      replyEligible: true,
      sourceType: "queue",
    },
  ],
};
const queue = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(handler) as unknown as typeof fetch;

const privateTestHomes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of privateTestHomes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical MAIN-only operator reply transport", () => {
  it("preflight blocks old daemons, wrong recipients and absent credentials without any POST", async () => {
    const requests = queue((url) => {
      expect(url).toContain("/human-inbox?");
      return Response.json({ ...inbox, replyWriteAvailable: false });
    });
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", ""); // explicitly disable disk fallback
    expect(await postOpenRigOperatorReply(input, requests)).toMatchObject({ outcome: "not_sent" });
    expect(vi.mocked(requests)).not.toHaveBeenCalled();
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "test-token-with-at-least-24-characters");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "test-bearer");
    expect(await postOpenRigOperatorReply(input, requests)).toMatchObject({ outcome: "not_sent" });
    expect(vi.mocked(requests).mock.calls).toHaveLength(1);
    const wrong = queue(() =>
      Response.json({
        ...inbox,
        items: [{ ...inbox.items[0], sender: "impostor@omni" }],
      }),
    );
    expect(await postOpenRigOperatorReply(input, wrong)).toMatchObject({ outcome: "not_sent" });
    expect(vi.mocked(wrong)).toHaveBeenCalledTimes(1);
  });

  it("supports direct desktop launch with the pre-provisioned private token file and bearer-free loopback daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-reply-main-only-"));
    privateTestHomes.push(home);
    const fileDir = join(home, ".openrig", "operator-tokens");
    mkdirSync(fileDir, { recursive: true });
    const testToken = "unit-test-existing-private-answer-token-123456789";
    writeFileSync(join(fileDir, "t3-human-answer-token.txt"), testToken, {
      encoding: "utf8",
      mode: 0o600,
    });
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", undefined);
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "");
    let writes = 0;
    const requests = queue((url, req) => {
      if (url.includes("destination=")) return Response.json(inbox);
      const headers = req.headers as Record<string, string>;
      expect(headers["x-openrig-human-answer-token"]).toBe(testToken);
      expect(headers.Authorization).toBeUndefined();
      expect(headers["x-openrig-human-intent"]).toBe("t3-desktop-ipc");
      if (req.method === "POST") {
        writes++;
        return Response.json(receipt);
      }
      throw new Error("unexpected method");
    });
    expect(await postOpenRigOperatorReply(input, requests)).toMatchObject({
      outcome: "accepted",
      replyQitemId,
      recipient: input.expectedRecipient,
    });
    expect(writes).toBe(1);
    // A blank explicit token must never silently pick up credentials from disk.
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "");
    const absent = queue(() => {
      throw Error("Not supposed to send");
    });
    expect(await postOpenRigOperatorReply(input, absent)).toMatchObject({ outcome: "not_sent" });
    expect(absent).not.toHaveBeenCalled();
  });

  it("POSTs only canonical body and headers, verifies hash, qitem, exact recipient and durable receipt", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "test-token-with-at-least-24-characters");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "test-bearer");
    let postCount = 0;
    const requests = queue((url, req) => {
      if (url.includes("destination=")) return Response.json(inbox);
      if (req.method !== "POST") throw new Error("unexpected request");
      postCount++;
      expect(url).toMatch(/\/human-inbox\/qitem-original-123\/reply$/);
      expect(JSON.parse(String(req.body))).toEqual({
        version: 1,
        destination: "human@kernel",
        requestId: input.requestId,
        message: input.message,
      });
      const headers = req.headers as Record<string, string>;
      expect(headers["x-openrig-human-intent"]).toBe("t3-desktop-ipc");
      expect(headers.Authorization).toBe("Bearer test-bearer");
      return Response.json(receipt);
    });
    const outcome = await postOpenRigOperatorReply(input, requests);
    expect(outcome).toMatchObject({
      outcome: "accepted",
      replyQitemId,
      recipient: input.expectedRecipient,
    });
    expect(postCount).toBe(1);
  });

  it("lost POST acknowledgement never repeats a write; single read-only GET may recover exact receipt", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "test-token-with-at-least-24-characters");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "test-bearer");
    let postCount = 0;
    let getCount = 0;
    const requests = queue((url, req) => {
      if (url.includes("destination=")) return Response.json(inbox);
      if (req.method === "POST") {
        postCount++;
        throw new Error("network lost after commit");
      }
      getCount++;
      expect(url).toContain("/replies/" + input.requestId);
      return Response.json(receipt);
    });
    expect(await postOpenRigOperatorReply(input, requests)).toMatchObject({ outcome: "accepted" });
    expect(postCount).toBe(1);
    expect(getCount).toBe(1);
    const mismatch = queue((url, req) =>
      req.method === "POST"
        ? Response.json({ ...receipt, recipient: "other@omni" })
        : Response.json({ outcome: "unconfirmed", acceptedIntoQueue: null }, { status: 404 }),
    );
    expect(await lookupOpenRigOperatorReply(input, mismatch)).toMatchObject({
      outcome: "unconfirmed",
    });
  });

  it("rejects spoofed 2xx receipts, keeps unresolved operation unknown, no duplicate POST", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "test-token-with-at-least-24-characters");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "test-bearer");
    let writes = 0;
    const requests = queue((url, req) => {
      if (url.includes("destination=")) return Response.json(inbox);
      if (req.method === "POST") {
        writes++;
        return Response.json({ ...receipt, messageSha256: "mismatch" });
      }
      return Response.json({ outcome: "unconfirmed", acceptedIntoQueue: null }, { status: 404 });
    });
    expect(await postOpenRigOperatorReply(input, requests)).toMatchObject({ outcome: "unknown" });
    expect(writes).toBe(1);
  });

  it("passes through typed legacy inbox capabilities as optional (fail closed when absent)", async () => {
    const older = { ...inbox };
    const payload = {
      ...older,
      replyWriteAvailable: undefined,
      answerWriteAvailable: undefined,
      items: [{ ...inbox.items[0], replyEligible: undefined, attentionKind: undefined }],
    };
    const result = await fetchOpenRigOperatorInbox(
      "human@kernel",
      queue(() => Response.json(payload)),
    );
    expect(result.replyWriteAvailable).toBeUndefined();
    expect(result.items[0]?.replyEligible).toBeUndefined();
  });
});
