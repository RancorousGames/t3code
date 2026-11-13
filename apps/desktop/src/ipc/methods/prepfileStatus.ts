// @effect-diagnostics nodeBuiltinImport:off -- Local prepfile handoff is restricted to the agent scratch tree.
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const scratchRoot = Path.win32.resolve("E:\\_AgentScratch");
const allowedPrefix = scratchRoot.toLowerCase() + "\\";

export const readPrepfileStatusIpc = DesktopIpc.makeIpcMethod({
  channel: Channels.PREPFILE_STATUS_CHANNEL,
  payload: Schema.Struct({ path: Schema.String }),
  result: Schema.Struct({
    exists: Schema.Boolean,
    size: Schema.Number,
    modifiedAtMs: Schema.Number,
  }),
  handler: Effect.fn("desktop.ipc.prepfileStatus")(function* ({ path }) {
    const resolved = Path.win32.resolve(path);
    const missing = { exists: false, size: 0, modifiedAtMs: 0 };
    if (
      !resolved.toLowerCase().startsWith(allowedPrefix) ||
      Path.win32.extname(resolved).toLowerCase() !== ".md"
    ) return missing;
    return yield* Effect.promise(async () => {
      try {
        const stat = await Fs.stat(resolved);
        return stat.isFile()
          ? { exists: true, size: stat.size, modifiedAtMs: stat.mtimeMs }
          : missing;
      } catch {
        return missing;
      }
    });
  }),
});
