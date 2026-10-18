import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

const DesktopAppActivationBase = {
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
};

export const DesktopAppActivationRequest = Schema.Union([
  Schema.Struct({
    ...DesktopAppActivationBase,
    type: Schema.Literal("open-workspace"),
    workspaceRoot: TrimmedNonEmptyString,
    platform: DesktopAppActivationPlatform,
  }),
  Schema.Struct({
    ...DesktopAppActivationBase,
    type: Schema.Literal("chatgpt.spawn"),
    title: TrimmedNonEmptyString,
    prompt: Schema.String.check(Schema.isNonEmpty()),
    parentSessionId: Schema.optional(TrimmedNonEmptyString),
    project: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...DesktopAppActivationBase,
    type: Schema.Literal("chatgpt.sessions"),
    action: Schema.Literals(["list", "read", "send", "reload"]),
    which: Schema.optional(Schema.Literals(["visible", "recent", "working", "blocked", "all"])),
    sessionId: Schema.optional(Schema.String),
    count: Schema.optional(Schema.Number),
    from: Schema.optional(Schema.Literals(["start", "end"])),
    message: Schema.optional(Schema.String),
    force: Schema.optional(Schema.Boolean),
  }),
]);
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "chatgpt-send-failed",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationChatGPTSuccess = Schema.Struct({
  ...DesktopAppActivationBase,
  ok: Schema.Literal(true),
  sessionId: TrimmedNonEmptyString,
  messageSent: Schema.Literal(true),
});

export const DesktopAppActivationChatGPTSessionsSuccess = Schema.Struct({
  ...DesktopAppActivationBase,
  ok: Schema.Literal(true),
  data: Schema.Unknown,
});

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppActivationChatGPTSuccess,
  DesktopAppActivationChatGPTSessionsSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;
