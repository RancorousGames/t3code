// @effect-diagnostics nodeBuiltinImport:off -- Electron main reads OMCPT's local per-ID title registry.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import { CHATGPT_BOOTSTRAP_TITLE_LOOKUP_CHANNEL } from "../channels.ts";

/** Read an exact Bootstrap UUID's persisted title without involving the guest.
 * OMCPT writes one JSON file per UUID under the same LOCALAPPDATA directory. */
export function readLocalChatGPTBootstrapTitle(id: string, localAppData = process.env.LOCALAPPDATA): string | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !localAppData) return null;
  try {
    const path = NodePath.join(localAppData, "OmniHub", "BootstrapTitles", `${id.toLowerCase()}.json`);
    const entry: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (!entry || typeof entry !== "object") return null;
    const record = entry as { id?: unknown; title?: unknown };
    if (record.id !== id.toLowerCase() || typeof record.title !== "string" ||
        record.title.length < 3 || record.title.length > 80 ||
        /[\[\]\x00-\x1f\x7f]/u.test(record.title)) return null;
    return record.title;
  } catch {
    return null;
  }
}

export const readChatGPTBootstrapTitleIpc = DesktopIpc.makeIpcMethod({
  channel: CHATGPT_BOOTSTRAP_TITLE_LOOKUP_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.chatgpt.bootstrapTitle.read")(function* (id) {
    return readLocalChatGPTBootstrapTitle(id);
  }),
});
