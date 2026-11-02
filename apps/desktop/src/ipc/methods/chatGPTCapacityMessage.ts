import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DesktopIpc from "../DesktopIpc.ts";
import { CHATGPT_CAPACITY_MESSAGE_CHANNEL } from "../channels.ts";
import { requestCapacityMessage } from "../../app/ChatGPTCapacityMessageClient.ts";
import type { CapacityMessageRequest } from "@t3tools/contracts";

/** Renderer cannot select a URL, credentials, or arbitrary OpenRig action. */
export const chatGPTCapacityMessageIpc = DesktopIpc.makeIpcMethod({
  channel: CHATGPT_CAPACITY_MESSAGE_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.chatgpt.capacity")(function* (input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid capacity admission input");
    const data = input as Record<string, unknown>;
    if (
      !["claim", "status", "submit", "uncertain", "release"].includes(String(data.action)) ||
      Object.keys(data).some(
        (key) =>
          ![
            "action",
            "messageId",
            "sessionId",
            "conversationId",
            "maxActiveWorkers",
            "reason",
          ].includes(key),
      )
    )
      throw new Error("Unsupported capacity action");
    return yield* Effect.promise(() => requestCapacityMessage(input as CapacityMessageRequest));
  }),
});
