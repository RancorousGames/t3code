import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

const ChatGPTConversationId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
);

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

const NativeOperationId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
);
// This local pipe performs read/send on EXISTING threads. Its MCP identity
// syntax is NOT a grant to create a thread, reserve a spawn or attest an agent.
// Encoded %HH components are opaque and forwarded verbatim.
const NativeReadSendThreadId = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mcp:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|thread:mcp:(?:[A-Za-z0-9._~:-]|%[0-9a-f]{2}){1,240})$/i,
  ),
)
  .check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((id: string) => {
      try {
        // Decode only to validate percent encoding; preserve the exact ID on wire.
        const decoded = decodeURIComponent(id);
        return (
          !id.includes("..") &&
          !decoded.includes("..") &&
          ![...decoded].some(
            (char) => /\s/u.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          )
        );
      } catch {
        return false;
      }
    }),
  );

const NativeCreateRequest = Schema.Struct({
  action: Schema.Literal("create"),
  clientRequestId: NativeOperationId,
  environmentId: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  runtime: Schema.Literals(["codex", "claude", "opencode"]),
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  title: TrimmedNonEmptyString,
  firstMessage: Schema.optional(TrimmedNonEmptyString),
  initialMessageId: Schema.optional(NativeOperationId),
});

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
    type: Schema.Literal("t3.threads"),
    action: Schema.Literals(["list", "read", "send", "providers"]),
    environmentId: Schema.optional(TrimmedNonEmptyString),
    threadId: Schema.optional(NativeReadSendThreadId),
    count: Schema.optional(Schema.Number),
    message: Schema.optional(Schema.String),
    clientRequestId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...DesktopAppActivationBase,
    type: Schema.Literal("t3.threads"),
    ...NativeCreateRequest.fields,
  }),
  Schema.Struct({
    ...DesktopAppActivationBase,
    // Legacy wire name remains accepted for in-flight operator requests.
    type: Schema.Literals(["chatgpt.reboot", "chatgpt.refresh"]),
    requestId: NativeOperationId,
    sessionId: NativeOperationId,
    // T3 resolves the old ChatGPT conversation for stable-session reboot requests.
    priorConversationId: Schema.optional(ChatGPTConversationId),
    prompt: Schema.optional(TrimmedNonEmptyString),
    phase: Schema.Literals(["begin", "status", "restore", "finalize"]),
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
    type: Schema.Literal("openrig.human_inbox"),
    action: Schema.Literals(["fetch_unread", "fetch_recent_read", "set_state", "reply"]),
    address: Schema.optional(TrimmedNonEmptyString),
    limit: Schema.optional(Schema.Number),
    itemId: Schema.optional(TrimmedNonEmptyString),
    sourceType: Schema.optional(Schema.Literals(["queue", "mailbox", "human_gate"])),
    state: Schema.optional(Schema.Literals(["read", "unread", "archived", "trash", "inbox"])),
    answers: Schema.optional(
      Schema.Array(
        Schema.Struct({
          questionId: TrimmedNonEmptyString,
          value: Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)]),
        }),
      ),
    ),
  }),
  Schema.Struct({
    ...DesktopAppActivationBase,
    type: Schema.Literal("chatgpt.sessions"),
    action: Schema.Literals([
      "list",
      "snapshot",
      "read",
      "send",
      "reconcile_send",
      "reload",
      "complete",
      "archive",
      "restore",
      "change_state",
      "rollover_finalize",
    ]),
    which: Schema.optional(Schema.Literals(["visible", "recent", "working", "blocked", "all"])),
    includeHidden: Schema.optional(Schema.Boolean),
    state: Schema.optional(Schema.Literals(["hidden", "unhidden", "closed"])),
    sessionId: Schema.optional(Schema.String),
    successorSessionId: Schema.optional(Schema.String),
    priorConversationId: Schema.optional(ChatGPTConversationId),
    successorConversationId: Schema.optional(ChatGPTConversationId),
    // Explicit user-authorized error recovery; preserve old guest rather than unloading it.
    recoveryMode: Schema.optional(Schema.Boolean),
    count: Schema.optional(Schema.Number),
    maxMessageChars: Schema.optional(Schema.Number),
    from: Schema.optional(Schema.Literals(["start", "end"])),
    message: Schema.optional(Schema.String),
    senderSessionId: Schema.optional(TrimmedNonEmptyString),
    expectedConversationId: Schema.optional(ChatGPTConversationId),
    force: Schema.optional(Schema.Boolean),
    managerDecision: Schema.optional(Schema.Boolean),
    reason: Schema.optional(TrimmedNonEmptyString),
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
  parentSessionId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
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
