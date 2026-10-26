import {
  DesktopOmniHubKeepAwakeQuerySchema,
  DesktopOmniHubKeepAwakeReadResultSchema,
  DesktopOmniHubKeepAwakeControlQuerySchema,
  DesktopOmniHubKeepAwakeControlReceiptSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readLocalOmniHubKeepAwake } from "../../app/OmniHubKeepAwakeReadModel.ts";
import { controlOmniHubKeepAwake } from "../../app/OmniHubKeepAwakeControl.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { OMNIHUB_KEEP_AWAKE_CONTROL_CHANNEL, OMNIHUB_KEEP_AWAKE_READ_CHANNEL } from "../channels.ts";

/**
 * Mutation invokes only the real OmniHub Tools owner-token MCP API in trusted
 * Electron main. The renderer cannot access the token or the underlying store.
 */
export const controlOmniHubKeepAwakeMonitorIpc = DesktopIpc.makeIpcMethod({
  channel: OMNIHUB_KEEP_AWAKE_CONTROL_CHANNEL,
  payload: DesktopOmniHubKeepAwakeControlQuerySchema,
  result: DesktopOmniHubKeepAwakeControlReceiptSchema,
  handler: Effect.fn("desktop.ipc.omniHubKeepAwake.control")(function* (input) {
    return yield* Effect.promise(() => controlOmniHubKeepAwake({
      monitorId: input.monitorId,
      action: input.action,
      clientRequestId: input.clientRequestId,
      ...(input.confirmedTargetId === undefined ? {} : { confirmedTargetId: input.confirmedTargetId }),
    }));
  }),
});

/**
 * Read-only Electron-main IPC. Renderer provides only its exact, persisted
 * session index (including hidden entries); the OmniHub store is read by MAIN.
 * This never starts a monitor, wakes a session or calls scheduler transports.
 */
export const readOmniHubKeepAwakeMonitorsIpc = DesktopIpc.makeIpcMethod({
  channel: OMNIHUB_KEEP_AWAKE_READ_CHANNEL,
  payload: DesktopOmniHubKeepAwakeQuerySchema,
  result: DesktopOmniHubKeepAwakeReadResultSchema,
  handler: Effect.fn("desktop.ipc.omniHubKeepAwake.read")(function* (input) {
    return yield* Effect.promise(() =>
      readLocalOmniHubKeepAwake({
        ...(input.sessions === undefined
          ? {}
          : {
              sessions: input.sessions.map((session) => ({
                id: session.id,
                kind: session.kind,
                ...(session.title === undefined ? {} : { title: session.title }),
                ...(session.url === undefined ? {} : { url: session.url }),
                ...(session.hidden === undefined ? {} : { hidden: session.hidden }),
              })),
            }),
        ...(input.checkedKinds === undefined ? {} : { checkedKinds: input.checkedKinds }),
      }),
    );
  }),
});
