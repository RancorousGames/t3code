import { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.setReady")(function* (ready) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.setRendererReady(ready);
  }),
});

export const enqueueChatGPT = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_CHATGPT_DELIVERY_ENQUEUE_CHANNEL,
  payload: Schema.Struct({
    messageId: Schema.String,
    sessionId: Schema.String,
    conversationId: Schema.String,
    body: Schema.String,
  }),
  result: Schema.Struct({
    messageId: Schema.String,
    sessionId: Schema.String,
    conversationId: Schema.String,
    status: Schema.String,
    attempts: Schema.Number,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    lastError: Schema.optional(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.appActivation.enqueueChatGPT")(function* (input) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return yield* activation.enqueueChatGPT(input);
  }),
});

/** Local read-only status snapshot. No message text or renderer/private composer data. */
export const deliveryDiagnostics = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_CHATGPT_DELIVERY_DIAGNOSTICS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({
    sampledAt: Schema.Number,
    total: Schema.Number,
    newCount: Schema.Number,
    counts: Schema.Struct({
      queued: Schema.Number,
      sending: Schema.Number,
      uncertain: Schema.Number,
      delivered: Schema.Number,
      needs_attention: Schema.Number,
      cancelled: Schema.Number,
    }),
    messages: Schema.Array(
      Schema.Struct({
        messageId: Schema.String,
        sessionId: Schema.String,
        conversationId: Schema.String,
        status: Schema.Literals([
          "queued",
          "sending",
          "uncertain",
          "delivered",
          "needs_attention",
          "cancelled",
        ]),
        attempts: Schema.Number,
        createdAt: Schema.Number,
        updatedAt: Schema.Number,
        reason: Schema.NullOr(Schema.String),
        queuedBehind: Schema.Number,
      }),
    ),
  }),
  handler: Effect.fn("desktop.ipc.appActivation.deliveryDiagnostics")(function* () {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return yield* activation.chatGPTDeliveryDiagnostics();
  }),
});

/** Publish only the verified, content-free T3 idle journal event. */
export const recordIdle = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_CHATGPT_IDLE_TRANSITION_CHANNEL,
  payload: Schema.Struct({
    environmentId: Schema.String,
    sessionId: Schema.String,
    conversationId: Schema.String,
    bindingRevision: Schema.NullOr(Schema.String),
    sequence: Schema.Number,
    eventId: Schema.String,
    observedAt: Schema.Number,
    turnCount: Schema.Number,
    kind: Schema.optional(Schema.Literals(["completed", "stopped"])),
  }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appActivation.recordIdle")(function* (event) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return yield* activation.recordChatGPTIdleTransition(event);
  }),
});

/** Report a verified guest mount to release an exact waiting delivery lane. */
export const recipientMounted = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_CHATGPT_RECIPIENT_MOUNTED_CHANNEL,
  payload: Schema.Struct({ sessionId: Schema.String, conversationId: Schema.String }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appActivation.recipientMounted")(function* (event) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return yield* activation.recipientMounted(event);
  }),
});

export const complete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL,
  payload: DesktopAppActivationResponse,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.complete")(function* (response) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.complete(response);
  }),
});
