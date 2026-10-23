// @effect-diagnostics nodeBuiltinImport:off -- Owner-authorized local-only private filesystem and Windows ACL boundary.
// @effect-diagnostics globalDate:off -- Snapshot timestamps are captured at the native OS boundary.
// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off -- Deliberately opaque private-write errors.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  DesktopChatGPTDraftSnapshotInput,
  DesktopChatGPTDraftSnapshotReceipt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PRIVATE_CHATGPT_DRAFT_SNAPSHOT_CHANNEL } from "../channels.ts";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

const Pending = Schema.Struct({
  text: Schema.String,
  original: Schema.String,
  url: Schema.String,
  before: Schema.Struct({
    totalTurns: Schema.Number,
    lastUserTurnKey: Schema.NullOr(Schema.String),
  }),
  policyEnrichment: Schema.Struct({
    schema: Schema.Literal("t3-c05-browser-optional/v1"),
    status: Schema.Literals(["deferred", "not_eligible", "prepared", "observed_user_turn"]),
    reason: Schema.optional(Schema.String),
    qitemIds: Schema.optional(Schema.Array(Schema.String)),
  }),
});
const Payload = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
  draft: Schema.String,
  uncertainSend: Schema.NullOr(Pending),
});
const Receipt = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  path: Schema.String,
  uncertainSendPresent: Schema.Boolean,
});

export interface PrivateDraftRecord {
  readonly schema: "t3-chatgpt-private-draft/v1";
  readonly savedAt: string;
  readonly payload: DesktopChatGPTDraftSnapshotInput;
  readonly sha256: string;
}

export function validatePrivateDraftInput(input: DesktopChatGPTDraftSnapshotInput): void {
  if (!UUID.test(input.sessionId)) throw new Error("Invalid exact ChatGPT session UUID.");
  if (input.draft.length > 1_000_000) throw new Error("Draft exceeds private snapshot limit.");
  const u = new URL(input.url);
  if (
    u.protocol !== "https:" ||
    !["chatgpt.com", "chat.openai.com"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw new Error("Invalid ChatGPT guest origin.");
  if (
    input.uncertainSend &&
    (input.uncertainSend.text.length > 1_000_000 || input.uncertainSend.original.length > 1_000_000)
  )
    throw new Error("Uncertain send exceeds private snapshot limit.");
}

export function makePrivateDraftRecord(
  payload: DesktopChatGPTDraftSnapshotInput,
  savedAt = new Date().toISOString(),
): PrivateDraftRecord {
  validatePrivateDraftInput(payload);
  const body = { schema: "t3-chatgpt-private-draft/v1" as const, savedAt, payload };
  const sha256 = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  return { ...body, sha256 };
}

/** Offline fixture/restore verifier. Never logs or returns sensitive payload to control-plane callers. */
export function verifyPrivateDraftRecord(record: PrivateDraftRecord): boolean {
  if (record.schema !== "t3-chatgpt-private-draft/v1" || !HASH.test(record.sha256)) return false;
  try {
    return makePrivateDraftRecord(record.payload, record.savedAt).sha256 === record.sha256;
  } catch {
    return false;
  }
}

function constrainPrivateDirectory(directory: string): void {
  if (process.platform !== "win32") return;
  const user =
    process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
  if (!user) throw new Error("User identity unavailable; no private snapshot written.");
  // Well-known SID grants remain locale-independent. Fail before writing if ACL cannot be applied.
  execFileSync(
    "icacls",
    [
      directory,
      "/inheritance:r",
      "/grant:r",
      `${user}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

export async function savePrivateChatGPTDraftSnapshot(
  payload: DesktopChatGPTDraftSnapshotInput,
  backupRoot = path.join(app.getPath("userData"), "PrivateChatGPTDraftSnapshots"),
): Promise<DesktopChatGPTDraftSnapshotReceipt> {
  const record = makePrivateDraftRecord(payload);
  const directory = path.join(backupRoot, payload.sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  constrainPrivateDirectory(backupRoot);
  constrainPrivateDirectory(directory);
  const filePath = path.join(directory, `${Date.now()}-${randomUUID()}.json`);
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform === "win32") {
    execFileSync(
      "icacls",
      [
        filePath,
        "/inheritance:r",
        "/grant:r",
        `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`,
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
      ],
      { stdio: "ignore", windowsHide: true },
    );
  }
  // Verify saved bytes, not only in-memory hash. No plaintext returned to the caller.
  const restored = JSON.parse(await readFile(filePath, "utf8")) as PrivateDraftRecord;
  if (
    !verifyPrivateDraftRecord(restored) ||
    restored.payload.sessionId !== payload.sessionId ||
    restored.payload.url !== payload.url
  )
    throw new Error("Private snapshot verification failed.");
  return {
    sessionId: payload.sessionId,
    url: payload.url,
    bytes: Buffer.byteLength(payload.draft, "utf8"),
    sha256: record.sha256,
    path: filePath,
    uncertainSendPresent: payload.uncertainSend !== null,
  };
}

export const savePrivateChatGPTDraftSnapshotIpc = DesktopIpc.makeIpcMethod({
  channel: PRIVATE_CHATGPT_DRAFT_SNAPSHOT_CHANNEL,
  payload: Payload,
  result: Receipt,
  handler: (input) =>
    Effect.tryPromise({
      try: () => savePrivateChatGPTDraftSnapshot(input),
      catch: () => new Error("Private ChatGPT draft snapshot failed; no backup is certified."),
    }),
});
