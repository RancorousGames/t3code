import * as Schema from "effect/Schema";

/** The desktop owns the guest. The server persists this portable record without dropping
 * forward-compatible browser metadata such as Bootstrap identity or OpenRig binding. */
export const ChatGPTRegistryRecord = Schema.Record(Schema.String, Schema.Unknown);
export type ChatGPTRegistryRecord = typeof ChatGPTRegistryRecord.Type;

export const ChatGPTRegistrySnapshot = Schema.Struct({
  contentHash: Schema.String,
  observedAt: Schema.Number,
  lastUserText: Schema.optional(Schema.String),
  lastAssistantText: Schema.optional(Schema.String),
  lastAssistantEndsWithQuestion: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  conversationId: Schema.optional(Schema.String),
  turnCount: Schema.optional(Schema.Number),
  activity: Schema.optional(Schema.Literals(["working", "idle", "interrupted", "failed", "unknown"])),
  signals: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ChatGPTRegistrySnapshot = typeof ChatGPTRegistrySnapshot.Type;

export const ChatGPTRegistryTimeline = Schema.Struct({
  active: Schema.optional(Schema.Number),
  refresh: Schema.optional(Schema.Number),
  reboot: Schema.optional(Schema.Number),
});
export type ChatGPTRegistryTimeline = typeof ChatGPTRegistryTimeline.Type;

export const ChatGPTRegistryMetadataPatch = Schema.Struct({
  title: Schema.optional(Schema.String),
  titleSource: Schema.optional(Schema.Literal("user")),
  project: Schema.optional(Schema.NullOr(Schema.String)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ChatGPTRegistryMetadataPatch = typeof ChatGPTRegistryMetadataPatch.Type;

export const ChatGPTRegistrySession = Schema.Struct({
  environmentId: Schema.String,
  sessionId: Schema.String,
  /** Bootstrap public ID, derived from the canonical desktop identity; null until registered. */
  publicSessionId: Schema.NullOr(Schema.String),
  record: ChatGPTRegistryRecord,
  snapshot: Schema.NullOr(ChatGPTRegistrySnapshot),
  timeline: Schema.optional(Schema.NullOr(ChatGPTRegistryTimeline)),
  metadataRevision: Schema.optional(Schema.Number),
  metadataPatch: Schema.optional(ChatGPTRegistryMetadataPatch),
  closedAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
});
export type ChatGPTRegistrySession = typeof ChatGPTRegistrySession.Type;

export const ChatGPTRegistryDriver = Schema.Struct({
  environmentId: Schema.String,
  driverId: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(Schema.Number),
});
export type ChatGPTRegistryDriver = typeof ChatGPTRegistryDriver.Type;

export const ChatGPTRegistryAction = Schema.Struct({
  requestId: Schema.String,
  environmentId: Schema.String,
  sessionId: Schema.String,
  driverId: Schema.String,
  actionId: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
  requestedAt: Schema.Number,
  dispatchedAt: Schema.NullOr(Schema.Number),
  result: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  resolvedAt: Schema.NullOr(Schema.Number),
});
export type ChatGPTRegistryAction = typeof ChatGPTRegistryAction.Type;
