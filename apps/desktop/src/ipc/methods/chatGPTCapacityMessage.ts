import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DesktopIpc from "../DesktopIpc.ts";
import { CHATGPT_CAPACITY_MESSAGE_CHANNEL } from "../channels.ts";
import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import type { CapacityMessageRequest } from "@t3tools/contracts";

/** Session-view capacity is admitted by the SAME T3 scheduler as TaskBoard,
 * independently of Keep T3 Busy. No remote OpenRig capacity ledger. */
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
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return yield* activation.capacityMessage(input as CapacityMessageRequest);
  }),
});
