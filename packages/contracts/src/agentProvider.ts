import * as Schema from "effect/Schema";

/**
 * T3-owned execution provider for OmniHub (t3.agent-provider/v1).
 *
 * Direct session operations remain usable without OpenRig. This contract is
 * NOT an organizational manager/worker registry: OpenRig owns durable seats,
 * canonical tasks, managed-agent queues, memory and human@kernel.
 *
 * Transport requestId is NOT submission clientRequestId. Native threads and
 * ChatGPT browser owners may both have UUID-shaped IDs; kind is explicit.
 */
export const T3_AGENT_PROVIDER_VERSION = "t3.agent-provider/v1" as const;

const OpaqueId = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2048));
const RequestId = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128));

export const AgentProviderV1SessionKind = Schema.Literals(["t3/thread", "t3/chatgpt"]);
export type AgentProviderV1SessionKind = typeof AgentProviderV1SessionKind.Type;

export const AgentProviderV1SessionRef = Schema.Struct({
  provider: Schema.Literal("t3"),
  id: OpaqueId,
});
export type AgentProviderV1SessionRef = typeof AgentProviderV1SessionRef.Type;

export const AgentProviderV1Source = Schema.Struct({
  environmentId: OpaqueId,
  rawThreadId: Schema.optional(OpaqueId),
  projectId: Schema.optional(OpaqueId),
  browserSessionId: Schema.optional(OpaqueId),
  conversationId: Schema.optional(Schema.NullOr(OpaqueId)),
});
export type AgentProviderV1Source = typeof AgentProviderV1Source.Type;

export const AgentProviderV1Capability = Schema.Literals([
  "ReadHistory",
  "ObserveLive",
  "PushUpdates",
  "Submit",
  "Interrupt",
  "RespondInteraction",
  "CreateSession",
  "ForkSession",
  "RenameSession",
  "ArchiveSession",
  "CloseSession",
  "DeleteSession",
  "RecoverSession",
  "ListModels",
  "ChangeModel",
  "ChangeReasoning",
  "ChangePermissionMode",
  "NativeQueue",
  "EditQueue",
  "Attachments",
  "IdempotentSubmit",
  "ObserveUsage",
  "ObserveFileChanges",
  "ObserveSubagents",
  "Desktop.Open",
  "Desktop.Focus",
  "Desktop.View",
  "Desktop.NativeInput",
]);
export type AgentProviderV1Capability = typeof AgentProviderV1Capability.Type;

export const AgentProviderV1Delivery = Schema.Literals([
  "WhenIdle",
  "Queue",
  "Steer",
  "RejectIfBusy",
  "Parallel",
]);
export type AgentProviderV1Delivery = typeof AgentProviderV1Delivery.Type;

export const AgentProviderV1State = Schema.Struct({
  reachability: Schema.Literals(["Reachable", "Unreachable", "Unknown"]),
  activity: Schema.Literals(["Idle", "Working", "WaitingOnUser", "Errored", "Unknown"]),
  confidence: Schema.Literals(["Confirmed", "Inferred", "Unknown"]),
  elsewhere: Schema.NullOr(Schema.Boolean),
  observedAt: Schema.String,
});

export const AgentProviderV1Session = Schema.Struct({
  ref: AgentProviderV1SessionRef,
  kind: AgentProviderV1SessionKind,
  source: AgentProviderV1Source,
  title: Schema.String,
  conversation: Schema.optional(Schema.NullOr(OpaqueId)),
  workspace: Schema.optional(Schema.NullOr(Schema.String)),
  parent: Schema.optional(Schema.NullOr(AgentProviderV1SessionRef)),
  state: AgentProviderV1State,
  capabilities: Schema.Array(AgentProviderV1Capability),
  deliveryModes: Schema.Array(AgentProviderV1Delivery),
  lastActivityAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type AgentProviderV1Session = typeof AgentProviderV1Session.Type;

export const AgentProviderV1HistoryItem = Schema.Struct({
  id: OpaqueId,
  revision: Schema.Number,
  kind: Schema.String,
  at: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.String)),
  parts: Schema.Array(Schema.Unknown),
  streaming: Schema.Boolean,
  completeness: Schema.Literals(["Full", "Partial", "Truncated"]),
});
export type AgentProviderV1HistoryItem = typeof AgentProviderV1HistoryItem.Type;

/** Read newest native timeline window, then walk backward with the server's opaque cursor. */
export const AgentProviderV1HistoryRequest = Schema.Struct({
  session: AgentProviderV1SessionRef,
  expectedEnvironmentId: OpaqueId,
  cursor: Schema.optional(Schema.NullOr(OpaqueId)),
});
export type AgentProviderV1HistoryRequest = typeof AgentProviderV1HistoryRequest.Type;

export const AgentProviderV1HistoryPage = Schema.Struct({
  items: Schema.Array(AgentProviderV1HistoryItem),
  older: Schema.NullOr(Schema.String),
  newer: Schema.NullOr(Schema.String),
  complete: Schema.Boolean,
  warning: Schema.optional(Schema.NullOr(Schema.String)),
  snapshotSequence: Schema.optional(Schema.Number),
});

// Desktop publishes a bounded, non-DOM local-session catalog over its own
// authenticated environment connection. No agent send authority is delegated.
export const AgentProviderV1DesktopSnapshot = Schema.Struct({
  environmentId: OpaqueId,
  sessions: Schema.Array(AgentProviderV1Session),
});

export const AgentProviderV1SessionPage = Schema.Struct({
  items: Schema.Array(AgentProviderV1Session),
  next: Schema.NullOr(Schema.String),
  complete: Schema.Boolean,
  sourceCursor: Schema.NullOr(Schema.String),
});

export const AgentProviderV1OperationStage = Schema.Literals([
  "Accepted",
  "Queued",
  "Delivered",
  "Running",
  "Completed",
  "Interrupted",
  "Cancelled",
  "Failed",
  "Unknown",
]);
export type AgentProviderV1OperationStage = typeof AgentProviderV1OperationStage.Type;

export const AgentProviderV1Operation = Schema.Struct({
  operationId: OpaqueId,
  clientRequestId: RequestId,
  state: AgentProviderV1OperationStage,
  confirmedStage: Schema.optional(AgentProviderV1OperationStage),
  session: AgentProviderV1SessionRef,
  observedAt: Schema.String,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  providerOperationId: Schema.optional(Schema.NullOr(OpaqueId)),
  /**
   * Native command intake is Accepted/Queued, NOT completed agent work.
   * Browser observed user turn is Delivered, NOT completed assistant turn.
   */
  receiptBasis: Schema.optional(Schema.String),
  nativeMessageId: Schema.optional(OpaqueId),
  nativeRunId: Schema.optional(OpaqueId),
  sourceSequence: Schema.optional(Schema.Number),
});
export type AgentProviderV1Operation = typeof AgentProviderV1Operation.Type;

export const AgentProviderV1Submit = Schema.Struct({
  session: AgentProviderV1SessionRef,
  content: Schema.Array(Schema.Unknown),
  delivery: AgentProviderV1Delivery,
  clientRequestId: RequestId,
  expectedConversation: Schema.optional(Schema.NullOr(OpaqueId)),
  expectedEnvironmentId: Schema.optional(Schema.NullOr(OpaqueId)),
});
export type AgentProviderV1Submit = typeof AgentProviderV1Submit.Type;

export const AgentProviderV1Update = Schema.Struct({
  id: OpaqueId,
  kind: Schema.String,
  session: Schema.optional(Schema.NullOr(AgentProviderV1SessionRef)),
  payload: Schema.Unknown,
  observedAt: Schema.String,
});
export const AgentProviderV1UpdateBatch = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  changes: Schema.Array(AgentProviderV1Update),
  gap: Schema.Boolean,
  complete: Schema.Boolean,
});

export const AgentProviderV1Hello = Schema.Struct({
  apiVersion: Schema.Literal(T3_AGENT_PROVIDER_VERSION),
  environmentId: OpaqueId,
  epoch: OpaqueId,
  supportedKinds: Schema.Array(AgentProviderV1SessionKind),
  capabilities: Schema.Array(AgentProviderV1Capability),
  sourceUpdatesComplete: Schema.Boolean,
});
export type AgentProviderV1Hello = typeof AgentProviderV1Hello.Type;

/**
 * Versioned multiplexed transport envelope. Method-specific params/results
 * are validated by the owning handler using the schemas above. Unknown
 * methods/capabilities return Unsupported. Existing T3 RPCs stay unchanged.
 */
export const AgentProviderV1Method = Schema.Literals([
  "hello",
  "sessions.list",
  "sessions.get",
  "sessions.history",
  "sessions.updates",
  "sessions.subscribe",
  "sessions.submit",
  "sessions.queue",
  "sessions.queue.edit",
  "sessions.interrupt",
  "desktop.sessions.publish",
  "sessions.respond",
  "sessions.settings.get",
  "sessions.settings.update",
  "operations.get",
]);
export type AgentProviderV1Method = typeof AgentProviderV1Method.Type;

export const AgentProviderV1Request = Schema.Struct({
  apiVersion: Schema.Literal(T3_AGENT_PROVIDER_VERSION),
  requestId: RequestId,
  // Unknown future methods are decoded and answered Unsupported, not dropped
  // by RPC framing before a versioned provider reply can be correlated.
  method: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(100)),
  params: Schema.Unknown,
});

export const AgentProviderV1ErrorCode = Schema.Literals([
  "Unsupported",
  "NotFound",
  "Unavailable",
  "Busy",
  "ConversationChanged",
  "EnvironmentChanged",
  "TimeoutUnknown",
  "InvalidInput",
  "Conflict",
  "Internal",
]);

export const AgentProviderV1Reply = Schema.Union([
  Schema.Struct({
    apiVersion: Schema.Literal(T3_AGENT_PROVIDER_VERSION),
    requestId: RequestId,
    ok: Schema.Literal(true),
    data: Schema.Unknown,
  }),
  Schema.Struct({
    apiVersion: Schema.Literal(T3_AGENT_PROVIDER_VERSION),
    requestId: RequestId,
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: AgentProviderV1ErrorCode,
      message: Schema.String,
      retryable: Schema.Boolean,
    }),
  }),
]);
