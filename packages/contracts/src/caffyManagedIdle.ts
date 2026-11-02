import * as Schema from "effect/Schema";

/** Read-only Caffy resume-on-idle projection. Ordinary T3 when-idle messages
 * do not belong in this monitor or share its lifecycle. */
export const CaffyManagedIdleSubscriptionSchema = Schema.Struct({
  id: Schema.String,
  managedSessionId: Schema.String,
  t3SessionId: Schema.String,
  conversationId: Schema.String,
  bindingRevision: Schema.String,
  qitemId: Schema.String,
  enabled: Schema.Boolean,
  state: Schema.Literals(["registered","pending_delivery","uncertain","cancelled","completed"]),
  lastEventSequence: Schema.Number,
  lastEventId: Schema.NullOr(Schema.String),
  pendingMessageId: Schema.NullOr(Schema.String),
  lastDeliveryStatus: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
});
export type CaffyManagedIdleSubscription = typeof CaffyManagedIdleSubscriptionSchema.Type;

export const CaffyManagedIdleReadResultSchema = Schema.Union([
  Schema.Struct({
    availability: Schema.Literal("ok"),
    observedAtMs: Schema.Number,
    eventDeliveryEnabled: Schema.Boolean,
    subscriptions: Schema.Array(CaffyManagedIdleSubscriptionSchema),
  }),
  Schema.Struct({
    availability: Schema.Literal("unavailable"),
    observedAtMs: Schema.Number,
    eventDeliveryEnabled: Schema.Boolean,
    subscriptions: Schema.Array(CaffyManagedIdleSubscriptionSchema),
    error: Schema.String,
  }),
]);
export type CaffyManagedIdleReadResult = typeof CaffyManagedIdleReadResultSchema.Type;
export const CaffyManagedIdleCancelResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.Literals(["cancelled","uncertain","unavailable"]),
  detail: Schema.String,
});
export type CaffyManagedIdleCancelResult = typeof CaffyManagedIdleCancelResultSchema.Type;
