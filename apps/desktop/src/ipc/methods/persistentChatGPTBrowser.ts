// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off - IPC failures are opaque to callers.
// Narrow, opt-in IPC for T3-owned ChatGPT Chromium sessions.
// Never reachable directly from chatgpt.com; only the T3 application renderer.
import { BrowserWindow, dialog } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  persistentChatGPTRequest,
  type PersistentChatGPTRequest,
} from "../../preview/PersistentChatGPTBrowser.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PERSISTENT_CHATGPT_REQUEST_CHANNEL } from "../channels.ts";

const Request = Schema.Union([
  Schema.Struct({ operation: Schema.Literals(["reset_host", "confirm_reset_host"]) }),
  Schema.Struct({
    operation: Schema.Literals(["attach", "input", "evaluate", "status"]),
    sessionId: Schema.String,
    environmentId: Schema.optional(Schema.String),
    profileId: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    width: Schema.optional(Schema.Number),
    height: Schema.optional(Schema.Number),
    expression: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
]);

export const persistentChatGPTRequestIpc = DesktopIpc.makeIpcMethod({
  channel: PERSISTENT_CHATGPT_REQUEST_CHANNEL,
  payload: Request,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.persistentChatGPTBrowser")(function* (input, event) {
    // A renderer from an embedded external page must never invoke arbitrary JS
    // or type into ChatGPT, even if it discovers the channel identifier.
    const senderId = event?.sender.id;
    const owner = BrowserWindow.getAllWindows().find((window) => {
      if (window.isDestroyed() || window.webContents.id !== senderId) return false;
      try {
        const url = new URL(window.webContents.getURL());
        return ["t3code:", "t3code-dev:"].includes(url.protocol) && url.hostname === "app";
      } catch { return false; }
    });
    if (!owner)
      throw new Error("Persistent browser IPC requires the T3 application window.");
    return yield* Effect.tryPromise({
      try: async () => {
        if (input.operation === "confirm_reset_host") {
          // Chromium pages are separate owned windows, above React dialogs.
          // A native modal stays clickable above those pages.
          const { response } = await dialog.showMessageBox(owner, {
            type: "warning",
            title: "Reset ChatGPT webviews",
            message: "Reset all ChatGPT webviews?",
            detail: "This terminates every live Chromium page and starts a fresh browser host. Saved conversations and sign-ins remain, but unsent drafts, uploads, and in-progress replies may be lost.",
            buttons: ["Reset webviews", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (response !== 0) return { reset: false };
          await persistentChatGPTRequest({ operation: "reset_host" });
          return { reset: true };
        }
        return persistentChatGPTRequest(input as PersistentChatGPTRequest);
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }),
});
