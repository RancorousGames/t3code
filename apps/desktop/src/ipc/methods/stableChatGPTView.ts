// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off - Electron IPC failures are opaque to the renderer, matching existing guarded browser IPC.
/**
 * Native T3 browser bridge. Electron main owns live WebContentsView pages,
 * and the replaceable T3 UI only controls their presentation geometry.
 * Every call validates its sender, session identity and origin.
 */
import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { appendChatGPTRecoveryAudit } from "./chatGPTRecoveryAudit.ts";

import * as DesktopIpc from "../DesktopIpc.ts";
import { STABLE_CHATGPT_VIEW_REQUEST_CHANNEL } from "../channels.ts";
import {
  createStableChatGPTViewRegistry,
  isNativeBrowserSlice,
  type StableChatGPTIdentity,
} from "../../preview/StableChatGPTViewRegistry.ts";
import { createStableChatGPTTooltipOverlay } from "../../preview/StableChatGPTTooltipOverlay.ts";
import {
  showDirectChatGPTOverlay,
  hideDirectChatGPTOverlay,
  updateDirectChatGPTOverlay,
} from "../../preview/DirectChatGPTOverlay.ts";
import {
  persistentChatGPTViewRequest,
  type PersistentChatGPTViewRequest,
} from "../../preview/PersistentChatGPTBrowser.ts";

const Identity = Schema.Struct({
  sessionId: Schema.String,
  environmentId: Schema.String,
  profileId: Schema.String,
});
const Rectangle = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const Request = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("recovery_event"),
    identity: Identity,
    kind: Schema.String,
    detail: Schema.String,
    attempt: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    operation: Schema.Literal("attach"),
    identity: Identity,
    url: Schema.String,
    forceNative: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    operation: Schema.Literal("present"),
    identity: Identity,
    bounds: Schema.NullOr(Rectangle),
  }),
  Schema.Struct({
    operation: Schema.Literal("tooltip"),
    identity: Identity,
    bounds: Schema.NullOr(Rectangle),
    html: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("navigate"),
    identity: Identity,
    url: Schema.String,
  }),
  Schema.Struct({
    operation: Schema.Literal("reload"),
    identity: Identity,
  }),
  Schema.Struct({
    operation: Schema.Literals(["back", "forward"]),
    identity: Identity,
  }),
  Schema.Struct({
    operation: Schema.Literals(["snapshot", "probe"]),
    identity: Identity,
  }),
  Schema.Struct({
    operation: Schema.Literal("evaluate"),
    identity: Identity,
    expression: Schema.String,
  }),
  Schema.Struct({
    operation: Schema.Literal("find"),
    identity: Identity,
    text: Schema.String,
    findNext: Schema.optional(Schema.Boolean),
    forward: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    operation: Schema.Literal("stop_find"),
    identity: Identity,
  }),
  Schema.Struct({
    operation: Schema.Literal("close"),
    identity: Identity,
  }),
]);

type Registry = ReturnType<typeof createStableChatGPTViewRegistry>;
const registries = new WeakMap<BrowserWindow, Registry>();
const tooltips = new WeakMap<BrowserWindow, ReturnType<typeof createStableChatGPTTooltipOverlay>>();

function trustedOwner(senderId: number): BrowserWindow {
  const owner = BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && window.webContents.id === senderId,
  );
  if (!owner) throw new Error("Native browser requests require a trusted T3 UI renderer.");
  const url = new URL(owner.webContents.getURL());
  if (!["t3code:", "t3code-dev:"].includes(url.protocol) || url.hostname !== "app") {
    throw new Error("Native browser requests must originate from the T3 application.");
  }
  return owner;
}

function registryFor(owner: BrowserWindow): Registry {
  let registry = registries.get(owner);
  if (!registry) {
    registry = createStableChatGPTViewRegistry(owner);
    registries.set(owner, registry);
  }
  return registry;
}

export const stableChatGPTViewRequestIpc = DesktopIpc.makeIpcMethod({
  channel: STABLE_CHATGPT_VIEW_REQUEST_CHANNEL,
  payload: Request,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.stableChatGPTView")(function* (input, event) {
    const owner = trustedOwner(event?.sender.id ?? -1);
    const identity: StableChatGPTIdentity = input.identity;
    // The audit must work for missing/unloaded native guests and must never
    // accidentally create an Electron browser registry or load a page.
    if (input.operation === "recovery_event") {
      return yield* Effect.try({
        try: () => appendChatGPTRecoveryAudit({ ...identity, kind: input.kind,
          detail: input.detail, attempt: input.attempt }),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      });
    }
    const registry = registryFor(owner);
    // The dedicated test slice retains the in-process renderer. Every real
    // ChatGPT session must use the persistent native HWND owner, even if an
    // old in-process page happened to exist before the migration.
    const useNative = isNativeBrowserSlice(identity);
    // HTML tooltips cannot overpaint a native page window, so hovercards use
    // the native tooltip window here as well.
    if (!useNative && input.operation === "tooltip") {
      return yield* Effect.tryPromise({
        try: async () => {
          if (input.bounds === null || input.html === null) {
            tooltips.get(owner)?.hide(identity.sessionId);
            return { visible: false };
          }
          const state = (await persistentChatGPTViewRequest({
            operation: "probe",
            identity,
          })) as { residency?: string };
          if (state.residency !== "resident")
            throw new Error("Cannot display tooltip for a nonresident Chromium page.");
          let overlay = tooltips.get(owner);
          if (!overlay) {
            overlay = createStableChatGPTTooltipOverlay(owner);
            tooltips.set(owner, overlay);
          }
          await overlay.show(identity.sessionId, input.bounds, input.html);
          return { visible: true };
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    }
    if (!useNative && input.operation === "present") {
      return yield* Effect.tryPromise({
        try: async () => {
          if (input.bounds === null) {
            hideDirectChatGPTOverlay(identity.sessionId);
            return { visible: false, display: "native" };
          }
          if (updateDirectChatGPTOverlay(identity.sessionId, owner, input.bounds)) {
            return { display: "native", visible: true };
          }
          const state = (await persistentChatGPTViewRequest({
            operation: "snapshot",
            identity,
          })) as { display?: string; nativeHwnd?: string; hostPid?: number };
          if (state.display !== "native" || !state.nativeHwnd || !state.hostPid)
            throw new Error("Persistent ChatGPT page does not have a native HWND.");
          return showDirectChatGPTOverlay({
            sessionId: identity.sessionId,
            owner,
            sourceHwnd: state.nativeHwnd,
            hostPid: state.hostPid,
            bounds: input.bounds,
          });
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    }
    if (!useNative && input.operation === "close") {
      tooltips.get(owner)?.hide(identity.sessionId);
      hideDirectChatGPTOverlay(identity.sessionId);
    }
    if (!useNative) {
      return yield* Effect.tryPromise({
        try: () => persistentChatGPTViewRequest(input as PersistentChatGPTViewRequest),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    }
    return yield* Effect.tryPromise({
      try: async () => {
        if (input.operation === "attach") {
          return { ...(await registry.attach(identity, input.url)), fallback: "native" };
        }
        if (input.operation === "tooltip" && (input.bounds === null || input.html === null)) {
          // A departing/closed session may still need to dismiss its hovercard.
          // The sender is already trusted; no need to resurrect a page.
          tooltips.get(owner)?.hide(identity.sessionId);
          return { visible: false };
        }
        // Missing native pages are expected while warming many sessions.
        // A probe must never throw or accidentally attach a guest.
        if (input.operation === "probe") return registry.probe(identity);
        if (input.operation === "snapshot") {
          // Legacy snapshot readers also inspect unloaded sessions. Return a
          // non-mutating absent snapshot instead of throwing from every poll.
          // A foreign environment/profile remains an identity error.
          const state = registry.probe(identity);
          if (state.residency === "missing" || state.residency === "unavailable") {
            return {
              sessionId: identity.sessionId,
              residency: state.residency,
              url: "",
              destroyed: true,
              loading: false,
              loadError: null,
            };
          }
        }
        registry.assertIdentity(identity);
        if (input.operation === "tooltip") {
          let overlay = tooltips.get(owner);
          if (!overlay) {
            overlay = createStableChatGPTTooltipOverlay(owner);
            tooltips.set(owner, overlay);
          }
          await overlay.show(identity.sessionId, input.bounds!, input.html!);
          return { visible: true };
        }
        if (input.operation === "find") {
          return registry.find(identity.sessionId, input.text, input.findNext, input.forward);
        }
        if (input.operation === "stop_find") {
          registry.stopFind(identity.sessionId);
          return { stopped: true };
        }
        if (input.operation === "present") {
          registry.present(identity.sessionId, input.bounds);
        } else if (input.operation === "navigate") {
          await registry.navigate(identity.sessionId, input.url);
        } else if (input.operation === "reload") {
          registry.reload(identity.sessionId);
        } else if (input.operation === "back" || input.operation === "forward") {
          registry.history(identity.sessionId, input.operation);
        } else if (input.operation === "evaluate") {
          return { result: await registry.evaluate(identity.sessionId, input.expression) };
        } else if (input.operation === "close") {
          registry.close(identity.sessionId);
        }
        return input.operation === "close"
          ? { closed: true }
          : registry.snapshot(identity.sessionId);
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }),
});
