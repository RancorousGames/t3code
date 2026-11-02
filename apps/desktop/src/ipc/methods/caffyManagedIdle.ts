import {
  CaffyManagedIdleReadResultSchema,
  CaffyManagedIdleCancelResultSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  CAFFY_MANAGED_IDLE_READ_CHANNEL,
  CAFFY_MANAGED_IDLE_CANCEL_CHANNEL,
} from "../channels.ts";
import {
  readCaffyManagedIdle,
  cancelCaffyManagedIdle,
} from "../../app/CaffyManagedIdleReadModel.ts";

/** The renderer cannot select arbitrary OpenRig URLs, credentials or methods. */
export const readCaffyManagedIdleIpc = DesktopIpc.makeIpcMethod({
  channel: CAFFY_MANAGED_IDLE_READ_CHANNEL,
  payload: Schema.Void,
  result: CaffyManagedIdleReadResultSchema,
  handler: Effect.fn("desktop.ipc.caffy.read")(function* () {
    return yield* Effect.promise(() => readCaffyManagedIdle());
  }),
});

export const cancelCaffyManagedIdleIpc = DesktopIpc.makeIpcMethod({
  channel: CAFFY_MANAGED_IDLE_CANCEL_CHANNEL,
  payload: Schema.String,
  result: CaffyManagedIdleCancelResultSchema,
  handler: Effect.fn("desktop.ipc.caffy.cancel")(function* (id) {
    return yield* Effect.promise(() => cancelCaffyManagedIdle(id));
  }),
});
