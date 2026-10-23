import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-specific scheduled quota-reset job shape. Shared ServerSettings only
// owns the small collection fields and their wire-compatible patch semantics.
export const ProviderResetWakeup = Schema.Struct({
  enabled: Schema.Boolean,
  projectId: ProjectId,
  armedResetAt: Schema.optionalKey(TrimmedNonEmptyString),
  lastTriggeredResetAt: Schema.optionalKey(TrimmedNonEmptyString),
  /** One-off explicit test, not tied to a provider quota window. */
  testRequestedAt: Schema.optionalKey(TrimmedNonEmptyString),
  lastTestResult: Schema.optionalKey(
    Schema.Struct({
      requestedAt: TrimmedNonEmptyString,
      status: Schema.Literals(["succeeded", "failed"]),
      message: TrimmedNonEmptyString,
      threadId: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  queued: Schema.optionalKey(
    Schema.Struct({
      text: TrimmedNonEmptyString,
      model: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type ProviderResetWakeup = typeof ProviderResetWakeup.Type;
