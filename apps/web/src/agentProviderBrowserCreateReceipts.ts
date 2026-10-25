import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

// Durable, write-ahead create intent. A crash between browser creation and its
// receipt is UNKNOWN, not permission to spawn again. Never evict tombstones.
const Receipt = Schema.Struct({
  environmentId: Schema.String,
  requestId: Schema.String,
  fingerprint: Schema.String,
  state: Schema.Literals(["Pending", "Created"]),
  sessionId: Schema.NullOr(Schema.String),
});
const Receipts = Schema.Array(Receipt);
type Receipt = typeof Receipt.Type;
const KEY = "t3code:provider-browser-create-writeahead:v1";
const MAX_RECEIPTS = 8_000;
function all(): readonly Receipt[] {
  return getLocalStorageItem(KEY, Receipts) ?? [];
}
export function getBrowserCreateIntent(environmentId: EnvironmentId, requestId: string) {
  return all().find((r) => r.environmentId === environmentId && r.requestId === requestId);
}
export function writeBrowserCreateIntent(entry: Receipt): boolean {
  const entries = all();
  const existing = getBrowserCreateIntent(entry.environmentId as EnvironmentId, entry.requestId);
  if (existing && (
    existing.fingerprint !== entry.fingerprint ||
    (existing.state === "Created" && entry.state !== "Created") ||
    (existing.sessionId !== null && entry.sessionId !== existing.sessionId)
  )) return false;
  if (!existing && entries.length >= MAX_RECEIPTS) return false;
  // Never allow this storage write to overwrite foreign receipts. The browser
  // session action proceeds only after read-after-write verifies persistence.
  setLocalStorageItem(
    KEY,
    existing
      ? entries.map((item) => item.environmentId === entry.environmentId &&
          item.requestId === entry.requestId ? entry : item)
      : [...entries, entry],
    Receipts,
  );
  const persisted = getBrowserCreateIntent(entry.environmentId as EnvironmentId, entry.requestId);
  return persisted?.state === entry.state && persisted.fingerprint === entry.fingerprint &&
    persisted.sessionId === entry.sessionId;
}

export async function browserCreateFingerprint(work: {
  title?: string | undefined; prompt?: string | undefined;
  project?: string | undefined; parentSessionId?: string | undefined;
}): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([
    work.title ?? "", work.prompt ?? "", work.project ?? "", work.parentSessionId ?? "",
  ]));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
