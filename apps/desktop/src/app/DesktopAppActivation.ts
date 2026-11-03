// @effect-diagnostics nodeBuiltinImport:off -- Local socket ownership checks need lstat, an atomic rename, and a directory watch at the Node adapter boundary.
import { pipe } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";
import { Notification, powerSaveBlocker } from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import { ChatGPTDeliveryQueue } from "./ChatGPTDeliveryQueue.ts";
import { CaffyScheduler } from "./CaffyScheduler.ts";
import { ChatGPTExecutionReceiptProducer } from "./ChatGPTExecutionReceiptProducer.ts";
import { ChatGPTIdleTransitionJournal, type VerifiedChatGPTIdleTransition } from "./ChatGPTIdleTransitionJournal.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CHATGPT_REQUEST_TIMEOUT_MS = 90_000;
const isDesktopAppActivationRequest = Schema.is(DesktopAppActivationRequest);

export class DesktopAppActivationStartError extends Schema.TaggedError<DesktopAppActivationStartError>()(
  "DesktopAppActivationStartError",
  {
    address: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the desktop app control socket at ${this.address}.`;
  }
}

interface RunningControlServer {
  readonly reclaim: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function invalidResponse(requestId: string, message: string): DesktopAppActivationResponse {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code: "invalid-request",
    message,
  };
}

function requestIdFromUnknown(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0
  ) {
    return value.requestId;
  }
  return "invalid-request";
}

async function prepareUnixDirectory(input: {
  readonly directory: string;
  readonly userId: number | undefined;
}): Promise<boolean> {
  const created = await NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(input.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${input.directory} is not a directory.`);
  }
  if (input.userId !== undefined && stat.uid !== input.userId) {
    throw new Error(`${input.directory} is owned by another user.`);
  }
  await NodeFSP.chmod(input.directory, 0o700);
  return created !== undefined;
}

async function inodeAt(path: string): Promise<number | null> {
  return NodeFSP.lstat(path).then(
    (stat) => stat.ino,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
}

function closeServer(server: NodeNet.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startDesktopAppControlServer(input: {
  readonly address: string;
  readonly directory: string | null;
  readonly userId: number | undefined;
  readonly handle: (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
  readonly cancel: (requestId: string) => void;
  readonly onReclaimError: (error: unknown) => void;
}): Promise<RunningControlServer> {
  const sockets = new Set<NodeNet.Socket>();
  const handleConnection = (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    let responseSent = false;
    let activeRequestId: string | null = null;

    socket.setTimeout(5_000, () => socket.destroy());

    const finish = (response: DesktopAppActivationResponse) => {
      responseSent = true;
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        finish(invalidResponse("invalid-request", "The desktop app request is too large."));
        return;
      }

      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(invalidResponse("invalid-request", "The desktop app request is not valid JSON."));
        return;
      }

      if (!isDesktopAppActivationRequest(parsed)) {
        pipe(
          requestIdFromUnknown(parsed),
          (requestId) => invalidResponse(requestId, "The desktop app request is invalid."),
          finish,
        );
        return;
      }
      activeRequestId = parsed.requestId;
      void input.handle(parsed).then(finish, () => {
        finish(
          invalidResponse(parsed.requestId, "T3 Code could not process the desktop app request."),
        );
      });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (!responseSent && activeRequestId !== null) input.cancel(activeRequestId);
    });
  };

  const listen = (address: string) =>
    new Promise<NodeNet.Server>((resolve, reject) => {
      const server = NodeNet.createServer(handleConnection);
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address);
    });

  // Closing unlinks the original bind path, even if another app replaced it. Bind a staging path first.

  const bindUnix = async (directory: string, mode: "take-over" | "claim-free") => {
    const staging = NodePath.join(directory, `${NodeCrypto.randomBytes(6).toString("hex")}.tmp`);
    const server = await listen(staging);
    try {
      await NodeFSP.chmod(staging, 0o600);
      const inode = await inodeAt(staging);
      if (mode === "take-over") {
        await NodeFSP.rename(staging, input.address);
      } else {
        await NodeFSP.link(staging, input.address);
        await NodeFSP.unlink(staging);
      }
      return { server, inode };
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  };

  let server: NodeNet.Server;
  let inode: number | null = null;
  if (input.directory === null) {
    server = await listen(input.address);
  } else {
    await prepareUnixDirectory({ directory: input.directory, userId: input.userId });
    ({ server, inode } = await bindUnix(input.directory, "take-over"));
  }

  let closed = false;
  const reclaimOnce = async () => {
    // Replacing an existing socket would let two apps trade the path indefinitely.
    if (closed || input.directory === null || (await inodeAt(input.address)) !== null) return;
    if (await prepareUnixDirectory({ directory: input.directory, userId: input.userId })) {
      // Directory watches follow inodes, so recreate the watch after directory replacement.
      watchDirectory(input.directory);
    }
    const next = await bindUnix(input.directory, "claim-free").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return null;
        throw error;
      },
    );
    if (next === null) return;
    const previous = server;
    ({ server, inode } = next);
    previous.close();
  };
  let pendingReclaim = Promise.resolve();
  const reclaim = () => {
    const run = pendingReclaim.then(reclaimOnce);
    pendingReclaim = run.catch(() => undefined);
    return run;
  };
  let watcher: NodeFS.FSWatcher | null = null;
  const watchDirectory = (directory: string) => {
    watcher?.close();
    watcher = null;
    try {
      watcher = NodeFS.watch(directory, { persistent: false }, () => {
        reclaim().catch(input.onReclaimError);
      });
      watcher.on("error", input.onReclaimError);
    } catch (error) {
      input.onReclaimError(error);
    }
  };
  if (input.directory !== null) {
    watchDirectory(input.directory);
    // Catch a removal that happened before the watcher started.
    reclaim().catch(input.onReclaimError);
  }

  return {
    reclaim,
    close: async () => {
      if (closed) return;
      closed = true;
      // Reclaim can replace the watcher; close it afterward.
      await pendingReclaim;
      watcher?.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      server.removeAllListeners();
      if (inode !== null && (await inodeAt(input.address)) === inode) {
        await NodeFSP.unlink(input.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

export class DesktopAppActivation extends Context.Service<
  DesktopAppActivation,
  {
    readonly start: Effect.Effect<void, DesktopAppActivationStartError, Scope.Scope>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly complete: (response: DesktopAppActivationResponse) => Effect.Effect<void>;
    readonly enqueueChatGPT: (input: {
      messageId: string;
      sessionId: string;
      conversationId: string;
      body: string;
    }) => Effect.Effect<ReturnType<ChatGPTDeliveryQueue["enqueue"]>>;
    readonly recordChatGPTIdleTransition: (event: VerifiedChatGPTIdleTransition) => Effect.Effect<boolean>;
    readonly recipientMounted: (event: { sessionId: string; conversationId: string }) => Effect.Effect<boolean>;
    readonly chatGPTDeliveryStatus: (
      messageId: string,
    ) => Effect.Effect<ReturnType<ChatGPTDeliveryQueue["status"]> | null>;
    readonly chatGPTDeliveryDiagnostics: () => Effect.Effect<
      ReturnType<ChatGPTDeliveryQueue["diagnostics"]>
    >;
    readonly caffyControl: (
      request: Extract<DesktopAppActivationRequest, { type: "caffy" }>,
    ) => Effect.Effect<unknown>;
  }
>()("@t3tools/desktop/app/DesktopAppActivation") {}

const { logWarning } = makeComponentLogger("desktop-app-activation");

/** @public */
export const make = Effect.gen(function* () {
  const desktopEnvironment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const path = yield* Path.Path;
  const userId = yield* HostProcess.UserId;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const address = resolveDesktopAppControlAddress({
    stateDir: path.resolve(desktopEnvironment.stateDir),
    platform: desktopEnvironment.platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: path.join,
  });
  let registeredWebContents: Electron.WebContents | null = null;
  let detachRendererListeners: (() => void) | null = null;

  const broker = new DesktopAppActivationBroker({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    chatGPTRequestTimeoutMs: CHATGPT_REQUEST_TIMEOUT_MS,
    trace: (stage, requestId, detail) => {
      void runPromise(logWarning("delivery trace", { stage, requestId, detail }));
    },
    activate: () => {
      void runPromise(
        desktopWindow.activate.pipe(
          Effect.catchCause((cause) => logWarning("failed to focus the desktop window", { cause })),
        ),
      );
    },
  });

  const idleJournal = new ChatGPTIdleTransitionJournal(path.resolve(desktopEnvironment.stateDir));
  const deliveries = new ChatGPTDeliveryQueue(
    path.resolve(desktopEnvironment.stateDir),
    (request) => broker.request(request),
    (record) => {
      if (Notification.isSupported()) {
        new Notification({ title: "T3 message delivery stopped", body: `Session ${record.sessionId}: ${record.attempts} attempts. Delivery ${record.messageId} retained for debugging.` }).show();
      }
    },
  );
  // T3 delivery is authoritative; receipt transport observes persisted state only.
  // No OpenRig outage can delay, reject or retry a ChatGPT composer submission.
  const executionReceipts = new ChatGPTExecutionReceiptProducer(
    path.resolve(desktopEnvironment.stateDir),
  );
  deliveries.subscribeTransitions(record => executionReceipts.observe(record));
  executionReceipts.resumePending();
  for (const record of deliveries.list()) executionReceipts.observe(record);
  const caffy = new CaffyScheduler(
    path.resolve(desktopEnvironment.stateDir), deliveries,
    (request) => broker.request(request),
    {
      start: () => powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id) => { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); },
    },
  );
  const handleRequest = (
    request: DesktopAppActivationRequest,
  ): Promise<DesktopAppActivationResponse> => {
    if (request.type === "caffy") {
      const action = request.action;
      return (async () => {
        try {
          let conversationId = request.conversationId;
          if (action === "set" && !conversationId && request.sessionId) {
            const inventory = await broker.request({
              version: 1, requestId: NodeCrypto.randomUUID(), type: "chatgpt.sessions",
              action: "list", which: "all", includeHidden: true,
            });
            if (inventory.ok && "data" in inventory && inventory.data &&
                typeof inventory.data === "object") {
              const entries = (inventory.data as {sessions?: Array<{
                id: string; browserSessionId?: string; publicSessionId?: string;
                conversationId?: string | null;
                bootstrapIdentity?: {conversationId?: string};
              }>}).sessions ?? [];
              const match = entries.filter(item => item.id === request.sessionId ||
                item.browserSessionId === request.sessionId || item.publicSessionId === request.sessionId);
              if (match.length === 1)
                conversationId = match[0]?.conversationId ?? match[0]?.bootstrapIdentity?.conversationId;
            }
          }
          const data = action === "set"
            ? await caffy.set({
                sessionId: request.sessionId ?? "",
                conversationId: conversationId ?? "",
                mode: request.mode ?? "idle",
                durationMinutes: request.durationMinutes,
                intervalMinutes: request.intervalMinutes,
                onceOnly: request.onceOnly,
                startup: request.startup,
                keepAwake: request.keepAwake,
              })
            : action === "list" || action === "status"
              ? caffy.status(action === "status" ? request.sessionId : undefined)
            : action === "policy"
              ? caffy.policy({ keepT3Busy: request.keepT3Busy, maxWorking: request.maxWorking })
            : action === "stop"
              ? caffy.stop(request.sessionId ?? "")
            : action === "pause" || action === "resume"
              ? caffy.pause(request.sessionId ?? "", action === "pause")
            : action === "startup"
              ? caffy.startup(request.sessionId ?? "", request.startup === true)
            : caffy.wake(request.sessionId ?? "");
          return { version: 1 as const, requestId: request.requestId, ok: true as const, data };
        } catch (error) {
          return { version: 1 as const, requestId: request.requestId, ok: false as const,
            code: "invalid-request" as const,
            message: error instanceof Error ? error.message : String(error) };
        }
      })();
    }
    if (request.type !== "chatgpt.sessions") return broker.request(request);
    if (request.action === "idle_status" || request.action === "idle_wait") {
      const environmentId = request.environmentId;
      const sessionId = request.sessionId;
      const afterSequence = request.afterSequence ?? 0;
      if (!environmentId || !sessionId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId) ||
          !Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
          (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 || request.timeoutMs > 30_000))) {
        return Promise.resolve({ version: 1, requestId: request.requestId, ok: false,
          code: "invalid-request", message: "Exact environment, session UUID and bounded sequence/time required." });
      }
      const reply = (event: VerifiedChatGPTIdleTransition | null) => ({
        version: 1 as const, requestId: request.requestId, ok: true as const,
        data: { event, lastKnownOnly: true, currentBindingVerified: false,
          deliveryStatusAction: "delivery_status", currentSessionStatusAction: "read" },
      });
      if (request.action === "idle_status") return Promise.resolve(reply(idleJournal.get(environmentId, sessionId)));
      return idleJournal.wait(environmentId, sessionId, afterSequence, request.timeoutMs ?? 25_000).then(reply);
    }
    if (!["enqueue", "delivery_status", "delivery_list", "cancel_delivery"].includes(request.action))
      return broker.request(request);
    try {
      const action = request.action;
      const data =
        action === "enqueue"
          ? deliveries.enqueue({
              messageId: request.messageId ?? "",
              sessionId: request.sessionId ?? "",
              conversationId: request.expectedConversationId ?? "",
              body: request.message ?? "",
            })
          : action === "delivery_status"
            ? deliveries.status(request.messageId ?? "")
            : action === "cancel_delivery"
              ? deliveries.cancel(request.messageId ?? "")
              : deliveries.list();
      return Promise.resolve({ version: 1, requestId: request.requestId, ok: true, data });
    } catch (error) {
      return Promise.resolve({
        version: 1,
        requestId: request.requestId,
        ok: false,
        code: "invalid-request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clearRegisteredRenderer = () => {
    detachRendererListeners?.();
    detachRendererListeners = null;
    registeredWebContents = null;
    broker.clearRenderer();
  };

  return DesktopAppActivation.of({
    enqueueChatGPT: (input) => Effect.sync(() => deliveries.enqueue(input)),
    recipientMounted: (event) => Effect.sync(() => deliveries.onRecipientMounted(event)),
    recordChatGPTIdleTransition: (event) => Effect.sync(() => {
      const accepted = idleJournal.record(event);
      if (accepted) {
        deliveries.onIdleTransition(event);
        caffy.onIdle(event);
      }
      return accepted;
    }),
    chatGPTDeliveryStatus: (messageId) =>
      Effect.sync(() => deliveries.list().find((entry) => entry.messageId === messageId) ?? null),
    chatGPTDeliveryDiagnostics: () => Effect.sync(() => deliveries.diagnostics()),
    caffyControl: (request) => Effect.promise(async () => {
      const response = await handleRequest(request);
      if (!response.ok) throw new Error(response.message);
      return "data" in response ? response.data : null;
    }),
    start: Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startDesktopAppControlServer({
            ...address,
            userId,
            handle: handleRequest,
            cancel: (requestId) => broker.cancel(requestId),
            onReclaimError: (cause) =>
              void runPromise(
                logWarning("failed to restore the desktop app control socket", { cause }),
              ),
          }),
        catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
      }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to close the desktop app control socket", { cause }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              caffy.close();
              deliveries.close();
              broker.close();
            }),
          ),
        ),
    ).pipe(
      Effect.tap(() => Effect.sync(() => { deliveries.start(); caffy.start(); })), 
      Effect.asVoid,
    ),
    setRendererReady: Effect.fn("DesktopAppActivation.setRendererReady")(function* (ready) {
      if (!ready) {
        clearRegisteredRenderer();
        return;
      }
      const main = yield* electronWindow.main;
      if (Option.isNone(main)) return;
      const webContents = main.value.webContents;
      if (webContents.isDestroyed()) return;

      if (registeredWebContents !== webContents) {
        clearRegisteredRenderer();
        registeredWebContents = webContents;
        const onUnavailable = () => clearRegisteredRenderer();
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) clearRegisteredRenderer();
        };
        const onConsoleMessage = (
          event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
        ) => {
          const message = event.message;
          if (message.startsWith("[t3-delivery-trace] "))
            void runPromise(logWarning("renderer delivery trace", { trace: message.slice(20) }));
        };
        webContents.on("console-message", onConsoleMessage);
        webContents.on("did-start-navigation", onNavigation);
        webContents.once("destroyed", onUnavailable);
        detachRendererListeners = () => {
          webContents.removeListener("console-message", onConsoleMessage);
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("destroyed", onUnavailable);
        };
      }

      broker.registerRenderer((request) => {
        webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
      });
    }),
    // The IPC handler owns the activation-completion span.
    complete: Effect.fnUntraced(function* (response) {
      return yield* Effect.sync(() => broker.complete(response));
    }),
  });
});

export const layer = Layer.effect(DesktopAppActivation, make);
