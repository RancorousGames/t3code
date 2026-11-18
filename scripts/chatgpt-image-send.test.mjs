import { test } from "node:test";
import Assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { sendChatGPTImage } from "./chatgpt-image-send.mjs";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function runScenario(mode) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-image-retry-"));
  const imagePath = Path.join(root, "test.png");
  const fileBytes = Buffer.from("tiny image fixture");
  FS.writeFileSync(imagePath, fileBytes);
  let attempt = -1;
  let stages = 0;
  let resets = 0;
  let submits = 0;
  let cancelled = false;
  const control = async (request) => {
    if (request.action === "read") {
      return {
        session: {
          conversationId,
          observedGuestUrl: "https://chatgpt.com/c/" + conversationId,
        },
        verifiedConversationId: conversationId,
        conversationGuardValidated: true,
      };
    }
    Assert.equal(request.action, "experimental_evaluate");
    const expression = request.expression;
    const respond = (value) => ({ result: { ok: true, value } });
    if (expression.includes("const previous=window.__t3ChatGPTImageSend;"))
      return respond({ ok: true });
    if (expression.includes("s.chunks.push(")) return respond({ ok: true });
    if (expression.includes('const labels=["Attach photos","Attach photos or videos","Attach files"]')) {
      attempt++;
      stages++;
      cancelled = false;
      return respond({ ok: true, label: ["Attach photos", "Attach photos or videos", "Attach files"][attempt],
        route: "react_handler", fileInputCount: 0 });
    }
    if (expression.includes("const attachments=Array.isArray(p.attachments)")) {
      const status = cancelled
        ? { attachments: 0, owned: false, attachmentStatus: null, ready: false }
        : mode === "all_stalled"
          ? { attachments: 1, owned: true, attachmentStatus: "uploading", ready: false }
        : mode === "other_attachment"
          ? { attachments: 1, owned: false, attachmentStatus: "ready", ready: false }
          : attempt === 0
            ? { attachments: 0, owned: false, attachmentStatus: null, ready: false }
            : { attachments: 1, owned: true, attachmentStatus: "ready", ready: true };
      return respond({
        ok: true, draftChanged: false, submitting: false, pending: false,
        uploads: 0, ...status,
      });
    }
    if (expression.includes("const a=p.attachments||[]")) {
      resets++;
      cancelled = true;
      return respond(mode === "all_stalled" ? { ok: true, removedId: "my-id" } : { ok: true, empty: true });
    }
    if (expression.includes("const result=p.onSubmit(")) {
      submits++;
      return respond({ ok: true, submitted: true });
    }
    if (expression.includes("const el=[...document.querySelectorAll("))
      return respond({ found: true, imageCount: 1, callbackOutcome: "accepted" });
    if (expression.includes("let deferredCleanup=false")) return respond(true);
    throw Error("Unknown guest expression: " + expression.slice(0, 200));
  };
  try {
    const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const receipt = await sendChatGPTImage({
      requestId, sessionId, expectedConversationId: conversationId,
      message: "test", imagePath,
    }, { home: root, control, wait: async () => {} });
    const persisted = JSON.parse(FS.readFileSync(
      Path.join(root, "userdata", "chatgpt-image-deliveries-v1", requestId + ".json"), "utf8"));
    return { receipt, persisted, stages, resets, submits };
  } finally {
    FS.rmSync(root, { recursive: true, force: true });
  }
}

test("a missing React upload is re-staged once, then submitted exactly once", async () => {
  const r = await runScenario("missing_first");
  Assert.equal(r.receipt.status, "delivered");
  Assert.equal(r.receipt.imageCount, 1);
  Assert.equal(r.stages, 2);
  Assert.equal(r.resets, 1);
  Assert.equal(r.submits, 1);
  Assert.deepEqual(r.persisted.stageAttempts.map((a) => a.label),
    ["Attach photos", "Attach photos or videos"]);
});

test("repeated stalled uploads never submit an unready attachment", async () => {
  const r = await runScenario("all_stalled");
  Assert.equal(r.receipt.status, "not_sent");
  Assert.equal(r.receipt.sendAttempted, false);
  Assert.equal(r.stages, 3);
  Assert.equal(r.resets, 2);
  Assert.equal(r.submits, 0);
});

test("a foreign attachment aborts without removing or submitting it", async () => {
  const r = await runScenario("other_attachment");
  Assert.equal(r.receipt.status, "not_sent");
  Assert.match(r.receipt.reason, /Attachment became unsafe/);
  Assert.equal(r.resets, 0);
  Assert.equal(r.submits, 0);
});
