// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Electron main forwards
// best-effort phone notifications to the already configured local OmniHub endpoint.
import { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
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

/** Caffy UI uses exactly the same main-process scheduler as OMCPT/CLI. */
export const caffyControl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_CAFFY_CONTROL_CHANNEL,
  payload: Schema.Struct({
    action: Schema.Literals(["set", "stop", "pause", "resume", "status", "list", "wake", "policy", "startup", "capacity", "tasks", "throughput", "working_snapshot", "retire", "begin_in", "auto_reboot", "schedule_spawn", "read_spawn", "edit_spawn", "cancel_spawn", "cancel_begin"]),
    sessionId: Schema.optional(Schema.String),
    conversationId: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["idle", "periodic", "startup"])),
    respectSlots: Schema.optional(Schema.Boolean),
    durationMinutes: Schema.optional(Schema.Number),
    intervalMinutes: Schema.optional(Schema.Number),
    onceOnly: Schema.optional(Schema.Boolean),
    startup: Schema.optional(Schema.Boolean),
    keepAwake: Schema.optional(Schema.Boolean),
    wakeNow: Schema.optional(Schema.Boolean),
    keepT3Busy: Schema.optional(Schema.Boolean),
    busyForMinutes: Schema.optional(Schema.Number),
    maxWorking: Schema.optional(Schema.Number),
    shutdownWhenIdle: Schema.optional(Schema.Boolean),
    workingSessionIds: Schema.optional(Schema.Array(Schema.String)),
    workingReporterId: Schema.optional(Schema.String),
    lifecycleReason: Schema.optional(Schema.Literals(["closed", "hidden", "snoozed", "missing"])),
    stopInitiator: Schema.optional(Schema.Literal("user")),
    beginAt: Schema.optional(Schema.NullOr(Schema.Number)),
    jobId: Schema.optional(Schema.String),
    onIdle: Schema.optional(Schema.Boolean),
    title: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    project: Schema.optional(Schema.String),
    rebootMinutes: Schema.optional(Schema.NullOr(Schema.Number)),
    rebootEveryRuns: Schema.optional(Schema.NullOr(Schema.Number)),
    repeatPrompt: Schema.optional(Schema.String),
  }),
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.appActivation.caffy")(function* (input) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return yield* activation.caffyControl({
      version: 1, requestId: NodeCrypto.randomUUID(),
      type: "caffy", ...input,
    });
  }),
});

/** Phone alerts are published only after the unified attention lifecycle becomes ready. */
async function publishAttentionPhone(input: {
  requestId: string;
  sessionId: string;
  message: string;
}): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:5000/api/internal/agent-attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const publishAgentAttention = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_AGENT_ATTENTION_PUBLISH_CHANNEL,
  payload: Schema.Struct({
    requestId: Schema.String,
    sessionId: Schema.String,
    message: Schema.String,
  }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appActivation.publishAgentAttention")((input) =>
    Effect.tryPromise(() => publishAttentionPhone(input))),
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
    evidenceKey: Schema.optional(Schema.String),
    observedAt: Schema.Number,
    turnCount: Schema.Number,
    kind: Schema.optional(Schema.Literals(["completed", "stopped", "quiescent"])),
  }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appActivation.recordIdle")(function* (event) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    const { kind, ...verified } = event;
    return yield* activation.recordChatGPTIdleTransition(
      kind === undefined ? verified : { ...verified, kind },
    );
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
