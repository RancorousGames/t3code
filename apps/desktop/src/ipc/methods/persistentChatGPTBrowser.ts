// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off - IPC failures are opaque to callers.
// Narrow, opt-in IPC for T3-owned ChatGPT Chromium sessions.
// Never reachable directly from chatgpt.com; only the T3 application renderer.
import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  persistentChatGPTRequest,
  type PersistentChatGPTRequest,
} from "../../preview/PersistentChatGPTBrowser.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PERSISTENT_CHATGPT_REQUEST_CHANNEL } from "../channels.ts";

const Request = Schema.Struct({
  operation: Schema.Literals(["attach", "input", "evaluate", "status"]),
  sessionId: Schema.String,
  environmentId: Schema.optional(Schema.String),
  profileId: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  expression: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export const persistentChatGPTRequestIpc = DesktopIpc.makeIpcMethod({
  channel: PERSISTENT_CHATGPT_REQUEST_CHANNEL,
  payload: Request,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.persistentChatGPTBrowser")(function* (input, event) {
    // A renderer from an embedded external page must never invoke arbitrary JS
    // or type into ChatGPT, even if it discovers the channel identifier.
    if (
      !event ||
      !BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.webContents.id === event.sender.id,
      )
    )
      throw new Error("Persistent browser IPC requires the T3 application window.");
    return yield* Effect.tryPromise({
      try: () => persistentChatGPTRequest(input as PersistentChatGPTRequest),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }),
});
