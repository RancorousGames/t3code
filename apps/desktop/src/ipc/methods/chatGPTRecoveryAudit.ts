// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/** Renderer recovery telemetry persisted outside Chromium localStorage for operator inspection.
 * Only T3's trusted app renderer can invoke this through stableChatGPTViewRequest.
 * No prompts, draft text, transcript, or guest document data is accepted. */
import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DETAILS = 220;

export function appendChatGPTRecoveryAudit(input: {
  environmentId: string;
  sessionId: string;
  kind: string;
  detail: string;
  attempt?: number | undefined;
}): { recorded: boolean; path: string } {
  if (!UUID.test(input.environmentId) || !UUID.test(input.sessionId))
    throw new Error("Recovery audit requires exact environment and session UUIDs.");
  if (!["deferred", "attempt", "outcome", "health", "retry", "backoff", "startup", "click"].includes(input.kind))
    throw new Error("Unsupported recovery audit kind.");
  if (input.detail.length > MAX_DETAILS)
    throw new Error("Recovery audit detail is too long.");
  // Source launches use T3CODE_HOME. Packaged builds use the Electron data directory.
  const directory = process.env.T3CODE_HOME
    ? join(process.env.T3CODE_HOME, "userdata", "logs")
    : join(app.getPath("userData"), "logs");
  const path = join(directory, "chatgpt-recovery-audit.ndjson");
  mkdirSync(directory, { recursive: true });
  if (existsSync(path) && statSync(path).size >= MAX_FILE_BYTES) {
    const prior = path + ".1";
    if (existsSync(prior)) unlinkSync(prior);
    renameSync(path, prior);
  }
  const record = {
    at: new Date().toISOString(),
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    kind: input.kind,
    detail: input.detail,
    ...(Number.isSafeInteger(input.attempt) && input.attempt! >= 0 ? { attempt: input.attempt } : {}),
  };
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return { recorded: true, path };
}
