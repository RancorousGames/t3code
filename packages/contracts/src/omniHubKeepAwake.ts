import * as Schema from "effect/Schema";

/**
 * Desktop-only read projection of OmniHub Tools' temporary keep-awake monitors.
 * Never add tokens, receipts, scheduler operations, or private source records.
 */
export const DesktopOmniHubKeepAwakeSessionKind = Schema.Literals([
  "t3/chatgpt_browser",
  "t3/native_thread",
]);
export const DesktopOmniHubKeepAwakeTargetSessionSchema = Schema.Struct({
  id: Schema.String,
  kind: DesktopOmniHubKeepAwakeSessionKind,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  hidden: Schema.optional(Schema.Boolean),
});
export type DesktopOmniHubKeepAwakeTargetSession =
  typeof DesktopOmniHubKeepAwakeTargetSessionSchema.Type;

export const DesktopOmniHubKeepAwakeQuerySchema = Schema.Struct({
  /** Exact local session snapshot supplied by the renderer; no guest loading. */
  sessions: Schema.optional(Schema.Array(DesktopOmniHubKeepAwakeTargetSessionSchema)),
  /** A missing session only means absent if its kind was actually enumerated. */
  checkedKinds: Schema.optional(Schema.Array(DesktopOmniHubKeepAwakeSessionKind)),
});
export type DesktopOmniHubKeepAwakeQuery = typeof DesktopOmniHubKeepAwakeQuerySchema.Type;

const source = Schema.Literal("omnihub-temporary-keep-awake");
const maybeTime = Schema.NullOr(Schema.Number);
const keepAwakeMonitorSchema = Schema.Struct({
  source,
  id: Schema.String,
  mandateId: Schema.String,
  target: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["t3/chatgpt_browser", "t3/native_thread", "unknown"]),
    title: Schema.String,
    url: Schema.NullOr(Schema.String),
    visibility: Schema.Literals(["visible", "hidden", "missing", "unchecked"]),
  }),
  status: Schema.Literals([
    "active",
    "attempting",
    "retrying",
    "final_pending",
    "final_retrying",
    "needs_attention",
    "completed",
    "cancelled",
    "history",
    "unknown",
  ]),
  activeOrPending: Schema.Boolean,
  finalWakePending: Schema.Boolean,
  oneShot: Schema.Boolean,
  intervalMinutes: maybeTime,
  createdAtMs: maybeTime,
  endAtMs: maybeTime,
  nextAttemptAtMs: maybeTime,
  lastSchedulerTickAtMs: maybeTime,
  lastWakeUserTurnAtMs: maybeTime,
  lastAssistantAckAtMs: maybeTime,
  finalDeliveredAtMs: maybeTime,
  wakeAttempts: Schema.Number,
  lastDelivery: Schema.NullOr(Schema.String),
  lastOutcome: Schema.NullOr(Schema.String),
  explanation: Schema.String,
});
export const DesktopOmniHubKeepAwakeReadResultSchema = Schema.Union([
  Schema.Struct({
    source,
    availability: Schema.Literal("ok"),
    observedAtMs: Schema.Number,
    monitors: Schema.Array(keepAwakeMonitorSchema),
  }),
  Schema.Struct({
    source,
    availability: Schema.Literal("unavailable"),
    observedAtMs: Schema.Number,
    monitors: Schema.Tuple([]),
    error: Schema.String,
  }),
]);
export type DesktopOmniHubKeepAwakeReadResult =
  typeof DesktopOmniHubKeepAwakeReadResultSchema.Type;
