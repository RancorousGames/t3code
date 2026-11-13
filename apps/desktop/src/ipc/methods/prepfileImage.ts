// @effect-diagnostics nodeBuiltinImport:off -- Bounded local-only image staging for user-supplied prepfile references.
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const extensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const MAX_BYTES = 8 * 1024 * 1024;

export const savePrepfileImageIpc = DesktopIpc.makeIpcMethod({
  channel: Channels.PREPFILE_IMAGE_CHANNEL,
  payload: Schema.Struct({ mime: Schema.String, dataUrl: Schema.String }),
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.savePrepfileImage")(function* ({ mime, dataUrl }) {
    const extension = extensions[mime];
    if (!extension) throw new Error("Unsupported prepfile image type.");
    if (dataUrl.length > Math.ceil(MAX_BYTES * 4 / 3) + 128)
      throw new Error("Prepfile image is too large.");
    const prefix = `data:${mime};base64,`;
    if (!dataUrl.startsWith(prefix)) throw new Error("Invalid prepfile image payload.");
    return yield* Effect.promise(async () => {
      const contents = Buffer.from(dataUrl.slice(prefix.length), "base64");
      if (!contents.length || contents.length > MAX_BYTES)
        throw new Error("Prepfile image is empty or exceeds 8 MiB.");
      const folder = Path.win32.join("E:\\_AgentScratch", "Unassigned", "Prepfile", "Images");
      await Fs.mkdir(folder, { recursive: true });
      const target = Path.win32.join(folder, `${randomUUID()}${extension}`);
      await Fs.writeFile(target, contents, { flag: "wx" });
      return target;
    });
  }),
});
