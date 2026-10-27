import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import {
  MessageId,
  ThreadId,
  T3_AGENT_PROVIDER_VERSION,
  type AgentProviderV1Session,
  type AgentProviderV1DesktopWork,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";

import { sendInitialChatGPTPrompt } from "../../chatGPTBrowserAutomation";
import { rebootChatGPTDesktop } from "../../chatGPTSameBrowserRebootDesktop";
import { recordChatGPTSpawnCreated, readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
} from "../../chatGPTBrowserSessions";
import {
  setLocalStorageItem,
  getLocalStorageItem,
  removeLocalStorageItem,
} from "../../hooks/useLocalStorage";
import {
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  clearThreadPreviewState,
  readThreadPreviewState,
} from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import {
  inspectBrowserSession,
  isLoadedChatGPTBrowserGuest,
  runChatGPTSessionControl,
} from "../../chatGPTSessionControl";
import { executeAgentProviderBrowserWork } from "../../agentProviderBrowser";
import { executeProviderBrowserCreate } from "../../agentProviderBrowserCreate";
import {
  resolveExistingChatGPTSessionAddress,
  resolveExplicitChatGPTConversationAddress,
} from "../../chatGPTConversationRouting";
import {
  releaseChatGPTDeliveryMount,
  requestChatGPTDeliveryMount,
} from "../../chatGPTDeliveryMountRequest";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { handleOpenRigHumanInboxActivation } from "./openRigHumanInboxActivation";
import { resolveExplicitChatGPTParent } from "../../chatGPTSessionLineage";
import {
  applyConfirmedChatGPTSessionMetadata,
  matchRegisteredProject,
} from "../../chatGPTSessionGrouping";
import {
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { useEffect, useEffectEvent, useRef } from "react";
import { flushSync } from "react-dom";

import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  normalizeProjectPathForComparison,
} from "../../lib/projectPaths";
import { newProjectId, randomUUID } from "../../lib/utils";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { orchestrationEnvironment } from "../../state/orchestration";
import {
  readProjects,
  readThreadShells,
  waitForProject,
  waitForThreadShell,
} from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { agentProviderCall } from "../../state/agentProvider";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const {
    createSession,
    removeSession,
    setSessionCompletion,
    setSessionArchived,
    setSessionHidden,
    finalizeRollover,
  } = useChatGPTBrowserSessions(primaryEnvironment?.environmentId ?? null);
  const closeChatGPTPreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const publishAgentProvider = useAtomCommand(agentProviderCall, {
    reportFailure: false,
    reportDefect: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const startNativeTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const createNativeThread = useOrchestrationCommand(threadEnvironment.create, {
    reportFailure: false,
  });
  const getNativeProjection = useAtomQueryRunner(orchestrationEnvironment.v2.threadProjection, {
    reportFailure: false,
    refresh: true,
  });
  const queueRef = useRef(Promise.resolve());
  const deliveryLanesRef = useRef(new Map<string, Promise<void>>());
  const activation = window.desktopBridge?.appActivation;
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const ready =
    activation !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  const processRequest = useEffectEvent(
    async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
      if (request.type === "t3.threads") {
        const environmentId = primaryEnvironment?.environmentId;
        if (
          !environmentId ||
          primaryEnvironment?.connection.phase !== "connected" ||
          (request.environmentId && request.environmentId !== environmentId)
        ) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "environment-unavailable",
            message: "Requested native environment is not connected.",
          };
        }
        if (request.action === "providers") {
          const data = {
            environmentId,
            providers: (primaryEnvironment.serverConfig?.providers ?? []).map((provider) => ({
              providerInstanceId: provider.instanceId,
              driver: provider.driver,
              enabled: provider.enabled,
              installed: provider.installed,
              status: provider.status,
              available: provider.availability !== "unavailable",
              models: provider.models.map((model) => ({
                slug: model.slug,
                isDefault: model.isDefault === true,
              })),
            })),
          };
          return { version: 1, requestId: request.requestId, ok: true, data };
        }
        if (request.action === "create") {
          const fail = (
            code: "invalid-request" | "thread-open-failed" | "project-create-failed",
            message: string,
          ) => ({
            version: 1 as const,
            requestId: request.requestId,
            ok: false as const,
            code,
            message,
          });
          // No composer/draft/router access. The runtime and instance must match a ready provider.
          const expectedDriver = {
            codex: "codex",
            claude: "claudeAgent",
            opencode: "opencode",
          }[request.runtime];
          const provider = primaryEnvironment.serverConfig?.providers.find(
            (candidate) => candidate.instanceId === request.providerInstanceId,
          );
          if (
            !provider ||
            provider.driver !== expectedDriver ||
            !provider.enabled ||
            !provider.installed ||
            provider.status !== "ready" ||
            provider.availability === "unavailable" ||
            request.modelSelection.instanceId !== request.providerInstanceId ||
            !provider.models.some((model) => model.slug === request.modelSelection.model)
          ) {
            return fail(
              "invalid-request",
              "Requested native provider instance/model is not ready, enabled, or an exact runtime match.",
            );
          }
          if (
            !/^[a-zA-Z]:\\/.test(request.workspaceRoot) &&
            !/^\\\\[^\\]+\\[^\\]+/.test(request.workspaceRoot) &&
            !request.workspaceRoot.startsWith("/")
          ) {
            return fail("invalid-request", "workspaceRoot must be an absolute path.");
          }
          if ((request.firstMessage === undefined) !== (request.initialMessageId === undefined)) {
            return fail(
              "invalid-request",
              "firstMessage and initialMessageId must be supplied together.",
            );
          }
          const normalizedRoot = normalizeProjectPathForComparison(request.workspaceRoot);
          const projects = readProjects().filter(
            (project) => project.environmentId === environmentId,
          );
          const matching = findProjectByPath(projects, request.workspaceRoot);
          if (request.projectId && matching?.id !== request.projectId) {
            return fail(
              "invalid-request",
              "Explicit projectId does not match exact workspaceRoot.",
            );
          }
          if (readThreadShells().some((thread) => thread.id === request.clientRequestId)) {
            return fail(
              "invalid-request",
              "Native thread operation ID already exists; reconcile by thread ID, do not retry.",
            );
          }
          let projectId = matching?.id;
          if (!projectId) {
            try {
              projectId = newProjectId();
              const created = await createProject({
                environmentId,
                input: {
                  projectId,
                  title: inferProjectTitleFromPath(request.workspaceRoot),
                  workspaceRoot: request.workspaceRoot,
                  createWorkspaceRootIfMissing: false,
                  defaultModelSelection: null,
                },
              });
              if (created._tag === "Failure") {
                const cause = squashAtomCommandFailure(created);
                throw cause instanceof Error ? cause : new Error("Project creation rejected.");
              }
              await waitForProject({ environmentId, projectId });
            } catch (error) {
              return fail(
                "project-create-failed",
                error instanceof Error ? error.message : "Project creation not confirmed.",
              );
            }
          }
          const confirmedProject = readProjects().find(
            (project) => project.environmentId === environmentId && project.id === projectId,
          );
          if (
            !confirmedProject ||
            normalizeProjectPathForComparison(confirmedProject.workspaceRoot) !== normalizedRoot
          ) {
            return fail(
              "project-create-failed",
              "Project was not persisted at the exact requested workspaceRoot.",
            );
          }
          if (
            !primaryEnvironment.serverConfig ||
            !resolveProjectProviderInstanceEnabled(
              primaryEnvironment.serverConfig.settings,
              projectId,
              request.providerInstanceId,
            )
          ) {
            return fail(
              "invalid-request",
              "Native provider instance is disabled for the exact requested project.",
            );
          }
          const threadId = ThreadId.make(request.clientRequestId);
          const createdAt = new Date().toISOString();
          try {
            const created = await createNativeThread({
              environmentId,
              input: {
                threadId,
                projectId,
                title: request.title,
                modelSelection: request.modelSelection,
                runtimeMode: request.runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            });
            if (created._tag === "Failure") {
              const cause = squashAtomCommandFailure(created);
              return fail(
                "thread-open-failed",
                cause instanceof Error ? cause.message : "Native thread creation rejected.",
              );
            }
            await waitForThreadShell({ environmentId, threadId });
          } catch (error) {
            return fail(
              "thread-open-failed",
              error instanceof Error ? error.message : "Native thread persistence indeterminate.",
            );
          }
          const thread = readThreadShells().find(
            (candidate) =>
              candidate.environmentId === environmentId &&
              candidate.id === threadId &&
              candidate.deletedAt === null,
          );
          if (
            !thread ||
            thread.projectId !== projectId ||
            thread.providerInstanceId !== request.providerInstanceId ||
            thread.modelSelection.instanceId !== request.modelSelection.instanceId ||
            thread.modelSelection.model !== request.modelSelection.model ||
            thread.runtimeMode !== request.runtimeMode
          ) {
            return fail(
              "thread-open-failed",
              "Native thread shell did not confirm exact persisted project/provider/model.",
            );
          }
          let messageId: string | undefined;
          if (request.firstMessage !== undefined && request.initialMessageId !== undefined) {
            try {
              const result = await startNativeTurn({
                environmentId,
                input: {
                  threadId,
                  message: {
                    messageId: MessageId.make(request.initialMessageId),
                    role: "user",
                    text: request.firstMessage,
                    attachments: [],
                  },
                  modelSelection: request.modelSelection,
                  runtimeMode: thread.runtimeMode,
                  interactionMode: thread.interactionMode,
                  dispatchMode: "queue",
                },
              });
              if (result._tag === "Failure") {
                const cause = squashAtomCommandFailure(result);
                return fail(
                  "thread-open-failed",
                  (cause instanceof Error ? cause.message : "Initial message rejected.") +
                    " Thread persisted; do not retry initial message.",
                );
              }
              const acknowledged = await getNativeProjection({
                environmentId,
                input: { threadId },
              });
              if (
                acknowledged._tag === "Failure" ||
                !acknowledged.value.messages.some(
                  (message) => message.id === request.initialMessageId && message.role === "user",
                )
              ) {
                return fail(
                  "thread-open-failed",
                  "Initial message commit not confirmed in native thread projection; reconcile by message ID, do not retry.",
                );
              }
              messageId = request.initialMessageId;
            } catch (error) {
              return fail(
                "thread-open-failed",
                (error instanceof Error
                  ? error.message
                  : "Initial message acceptance indeterminate.") +
                  " Thread persisted; do not retry initial message.",
              );
            }
          }
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              action: "create",
              environmentId,
              projectId,
              threadId,
              workspaceRoot: confirmedProject.workspaceRoot,
              runtime: request.runtime,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              created: true,
              ...(messageId ? { messageId, messageSent: true } : { messageSent: false }),
            },
          };
        }
        const threads = readThreadShells().filter(
          (thread) => thread.environmentId === environmentId && thread.deletedAt === null,
        );
        if (request.action !== "list") {
          if (!request.threadId || !threads.some((thread) => thread.id === request.threadId)) {
            return {
              version: 1,
              requestId: request.requestId,
              ok: false,
              code: "invalid-request",
              message: "Unknown native thread ID.",
            };
          }
          const thread = threads.find((entry) => entry.id === request.threadId)!;
          if (request.action === "read") {
            const projectionResult = await getNativeProjection({
              environmentId,
              input: { threadId: thread.id },
            });
            if (projectionResult._tag === "Failure") {
              const cause = squashAtomCommandFailure(projectionResult);
              return {
                version: 1,
                requestId: request.requestId,
                ok: false,
                code: "internal-error",
                message: cause instanceof Error ? cause.message : "Could not read native thread.",
              };
            }
            const count = Math.max(1, Math.min(20, request.count ?? 5));
            const messages = projectionResult.value.visibleTurnItems
              .slice(-count)
              .map(({ position, item }) => ({
                position,
                item,
              }));
            const data = { environmentId, threadId: thread.id, messages };
            if (JSON.stringify(data).length > 1_900_000) {
              return {
                version: 1,
                requestId: request.requestId,
                ok: false,
                code: "invalid-request",
                message: "Native thread read exceeds local response limit.",
              };
            }
            return { version: 1, requestId: request.requestId, ok: true, data };
          }
          if (!request.message?.trim() || !request.clientRequestId?.trim()) {
            return {
              version: 1,
              requestId: request.requestId,
              ok: false,
              code: "invalid-request",
              message: "Native send requires message and clientRequestId.",
            };
          }
          const messageId = MessageId.make(request.clientRequestId);
          const sendResult = await startNativeTurn({
            environmentId,
            input: {
              threadId: thread.id,
              message: { messageId, role: "user", text: request.message, attachments: [] },
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              dispatchMode: "queue",
            },
          });
          if (sendResult._tag === "Failure") {
            const cause = squashAtomCommandFailure(sendResult);
            return {
              version: 1,
              requestId: request.requestId,
              ok: false,
              code: "internal-error",
              message: cause instanceof Error ? cause.message : "Native thread send rejected.",
            };
          }
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              environmentId,
              threadId: thread.id,
              messageId,
              messageSent: true,
            },
          };
        }
        const projects = new Map(
          readProjects()
            .filter((project) => project.environmentId === environmentId)
            .map((project) => [project.id, project]),
        );
        const entries = threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          project: projects.get(thread.projectId)?.title ?? null,
          workspaceRoot: projects.get(thread.projectId)?.workspaceRoot ?? null,
          providerInstanceId: thread.providerInstanceId,
          runtime:
            primaryEnvironment.serverConfig?.providers.find(
              (provider) => provider.instanceId === thread.providerInstanceId,
            )?.driver ?? null,
          modelSelection: thread.modelSelection,
          status: thread.runtime?.status ?? "idle",
          provider: thread.providerInstanceId,
          parentThreadId: null,
        }));
        if (JSON.stringify(entries).length > 1_900_000) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "invalid-request",
            message: "Thread list exceeds local pipe response limit.",
          };
        }
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          data: {
            environmentId,
            threads: entries,
            // Running desktop capability, not a source-version claim or spawn
            // authorization. The typed pipe admits opaque IDs for read/send
            // only; above, both operations find the exact environment-scoped
            // durable shell ID, forward that same ID to the server, and echo
            // the exact recipient in their response. Send acknowledges only
            // after the native turn command succeeds with the caller's
            // clientRequestId as messageId. Create remains independently held
            // at MAIN and the server; no model/caller approval is implied.
            nativeThreadMessaging: {
              version: 1,
              environmentId,
              threadIdGrammar: "t3-native-opaque-read-send-v1",
              readOpaqueThreadIds: true,
              sendOpaqueThreadIds: true,
            },
          },
        };
      }
      if (request.type === "openrig.human_inbox") {
        return handleOpenRigHumanInboxActivation(request);
      }
      if (request.type === "chatgpt.sessions") {
        // These actions are owned by the durable desktop-main queue, not the renderer.
        if (
          request.action === "enqueue" ||
          request.action === "delivery_status" ||
          request.action === "delivery_list" ||
          request.action === "cancel_delivery"
        ) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "invalid-request",
            message: "Delivery queue action reached renderer instead of desktop main.",
          };
        }
        const environmentId = primaryEnvironment?.environmentId;
        if (!environmentId)
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "environment-unavailable",
            message: "Connect an environment first.",
          };
        let deliveryMountSessionId: string | undefined;
        try {
          const sessionSnapshot = readChatGPTBrowserSessions(environmentId);
          let resolvedSessionId = request.sessionId;
          let exactConversationId = request.expectedConversationId;
          if (
            request.action === "open" ||
            request.action === "read" ||
            request.action === "send" ||
            request.action === "reconcile_send"
          ) {
            if (!getChatGPTSessionPersistedStore(environmentId).persist.hasHydrated())
              throw new Error("ChatGPT session registry is not hydrated; no message sent.");
          }
          if (request.action === "open") {
            if (!request.sessionId) throw new Error("Explicit conversation ID required.");
            const address = resolveExplicitChatGPTConversationAddress(
              request.sessionId,
              sessionSnapshot,
              (id) => {
                const preview = readThreadPreviewState(chatGPTBrowserThreadRef(environmentId, id));
                const current = preview.snapshot?.navStatus;
                const saved = getLocalStorageItem(
                  chatGPTBrowserLastUrlKey(environmentId, id),
                  Schema.String,
                );
                return current?._tag === "Success" && chatGPTConversationIdFromUrl(current.url)
                  ? current.url
                  : saved;
              },
            );
            if (address.create) {
              flushSync(() => {
                resolvedSessionId = createSession(
                  `Conversation ${address.conversationId.slice(0, 8)}`,
                  { initialConversationUrl: `https://chatgpt.com/c/${address.conversationId}` },
                );
              });
            } else {
              resolvedSessionId = address.sessionId;
            }
            return {
              version: 1,
              requestId: request.requestId,
              ok: true,
              data: {
                action: "open",
                sessionId: resolvedSessionId,
                conversationId: address.conversationId,
                created: address.create,
              },
            };
          }
          if (
            request.action === "read" ||
            request.action === "send" ||
            request.action === "reconcile_send"
          ) {
            if (!request.sessionId) throw new Error("Existing T3 browser session ID required.");
            const address = resolveExistingChatGPTSessionAddress(
              request.sessionId,
              sessionSnapshot,
              request.expectedConversationId,
            );
            // Direct T3 session sends often omit expectedConversationId. For an
            // existing unloaded session, recover its exact persisted conversation
            // reference before requesting a targeted mount. Sending still waits
            // for an independently observed matching guest URL below.
            const savedConversation = chatGPTConversationIdFromUrl(
              getLocalStorageItem(
                chatGPTBrowserLastUrlKey(environmentId, address.sessionId),
                Schema.String,
              ),
            );
            exactConversationId =
              address.conversationId ??
              (request.action === "send" ||
              request.action === "reconcile_send" ||
              (request.action === "read" && request.wakeForSend === true)
                ? (savedConversation ?? undefined)
                : undefined);
            // Saved URLs are hints, never permission to create or retarget a
            // message. The loaded guest's identity is verified before delivery.
            resolvedSessionId = address.sessionId;
            // The direct T3 CLI first performs a guarded READ before SEND.
            // That read must wake its exact unloaded recipient as well; otherwise
            // the CLI rejects before the queued/durable send can begin.
            const deliveryNeedsGuest =
              request.action === "send" ||
              request.action === "reconcile_send" ||
              (request.action === "read" &&
                (!!exactConversationId || request.wakeForSend === true));
            if (deliveryNeedsGuest && resolvedSessionId) {
              if (!exactConversationId)
                throw new Error(
                  "Cannot wake and send: target has no exact saved ChatGPT conversation. No message sent.",
                );
              // Targeted wake, including sessions deferred by startup policy.
              // A rejected attempt stays queued in the desktop delivery journal.
              requestChatGPTDeliveryMount(environmentId, resolvedSessionId);
              deliveryMountSessionId = resolvedSessionId;
            }
            if (deliveryNeedsGuest && resolvedSessionId && exactConversationId) {
              // Confirm the physical guest URL; the send service checks composer
              // availability and repeats the exact-recipient guard before typing.
              const deadline = Date.now() + 55_000;
              let ready = false;
              while (Date.now() < deadline) {
                const entry = readChatGPTBrowserSessions(environmentId).find(
                  (candidate) => candidate.id === resolvedSessionId,
                );
                if (!entry) {
                  if (!getChatGPTSessionPersistedStore(environmentId).persist.hasHydrated())
                    throw new Error("ChatGPT session registry is not hydrated; no message sent.");
                  throw new Error(
                    "T3 browser session is missing; original recipient retained, no message sent.",
                  );
                }
                const status = await inspectBrowserSession(
                  environmentId,
                  entry.hidden ? { ...entry, hidden: false } : entry,
                  "end",
                  1,
                  true,
                );
                if (status.recoveryProblem)
                  throw new Error("ChatGPT page is unavailable before typing; no message sent.");
                const observed = chatGPTConversationIdFromUrl(status.observedGuestUrl);
                if (observed === exactConversationId) {
                  ready = true;
                  break;
                }
                const saved = chatGPTConversationIdFromUrl(
                  getLocalStorageItem(
                    chatGPTBrowserLastUrlKey(environmentId, resolvedSessionId),
                    Schema.String,
                  ),
                );
                if (observed && saved === observed && observed !== exactConversationId) {
                  console.info(
                    `[t3-delivery] ${request.requestId} original conversation replaced; dropping delivery`,
                  );
                  throw new Error(
                    "T3 browser session is missing; original recipient retained, no message sent.",
                  );
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 500));
              }
              if (!ready)
                throw new Error(
                  "ChatGPT conversation not yet mounted with verified messages; original session retained, no message sent.",
                );
            }
            if (
              request.action === "send" &&
              request.sendExpiresAt &&
              Date.now() >= request.sendExpiresAt
            )
              throw new Error(
                "Queued delivery expired during renderer preflight; no message sent.",
              );
          }
          if (request.action === "rollover_finalize") {
            const priorId = request.sessionId;
            const successorId = request.successorSessionId;
            const priorConversationId = request.priorConversationId;
            const successorConversationId = request.successorConversationId;
            if (
              !priorId ||
              !successorId ||
              !priorConversationId ||
              !successorConversationId ||
              priorId === successorId
            )
              throw new Error(
                "Exact distinct predecessor/successor browser and conversation IDs required.",
              );
            const original = sessionSnapshot.find((s) => s.id === priorId);
            const successor = sessionSnapshot.find((s) => s.id === successorId);
            if (!original || !successor || successor.hidden)
              throw new Error("Rollover session missing or successor hidden.");
            const oldUrl = `https://chatgpt.com/c/${priorConversationId}`;
            const alreadyArchived =
              original.hidden &&
              !!original.archive &&
              !original.archive.restoredAt &&
              original.archive.conversationUrl === oldUrl;
            const degraded = request.recoveryMode === true;
            if (degraded && (request.managerDecision !== true || !request.reason?.trim()))
              throw new Error("Error-state rollover requires a manager decision and audit reason.");
            // A failed ChatGPT guest should not veto a deliberate manager handover.
            // Preserve it without loading, sending, or claiming its draft is empty.
            if (degraded && !alreadyArchived) {
              const cachedOldUrl = getLocalStorageItem(
                chatGPTBrowserLastUrlKey(environmentId, priorId),
                Schema.String,
              );
              if (chatGPTConversationIdFromUrl(cachedOldUrl) !== priorConversationId)
                throw new Error("Unreachable predecessor lacks its exact saved conversation URL.");
              const oldState = await inspectBrowserSession(environmentId, original);
              if (oldState.activity === "working" || oldState.status === "working")
                throw new Error("Cannot recover while predecessor is generating.");
            }
            if (!alreadyArchived && !degraded) {
              // A successful OpenRig primary CAS does not prove a draft can be
              // discarded. Require an exact read and a private empty-draft backup.
              const checked = (await runChatGPTSessionControl({
                environmentId,
                sessions: sessionSnapshot,
                action: "read",
                sessionId: priorId,
                expectedConversationId: priorConversationId,
                count: 1,
              })) as { conversationGuardValidated?: boolean; verifiedConversationId?: string };
              if (
                !checked.conversationGuardValidated ||
                checked.verifiedConversationId !== priorConversationId
              )
                throw new Error("Predecessor conversation guard not verified.");
              const observed = await inspectBrowserSession(environmentId, original);
              if (
                observed.status !== "done_or_idle" ||
                observed.activity !== "idle" ||
                observed.lastRole !== "assistant" ||
                chatGPTConversationIdFromUrl(observed.observedGuestUrl) !== priorConversationId
              )
                throw new Error("Predecessor is not a verified idle completed assistant turn.");
              const draft = (await runChatGPTSessionControl({
                environmentId,
                sessions: sessionSnapshot,
                action: "snapshot",
                sessionId: priorId,
              })) as { status?: string; uncertainSendPresent?: boolean };
              if (draft.status !== "backed_up_empty" || draft.uncertainSendPresent === true)
                throw new Error(
                  "Predecessor draft/UNKNOWN send was not proved empty and backed up.",
                );
            }
            // Successor is independently bound to the canonical /c/<uuid>,
            // not merely a convenient title or current selected T3 tab.
            const checkedSuccessor = (await runChatGPTSessionControl({
              environmentId,
              sessions: sessionSnapshot,
              action: "read",
              sessionId: successorId,
              expectedConversationId: successorConversationId,
              count: 1,
            })) as { conversationGuardValidated?: boolean; verifiedConversationId?: string };
            if (
              !checkedSuccessor.conversationGuardValidated ||
              checkedSuccessor.verifiedConversationId !== successorConversationId
            )
              throw new Error("Successor conversation guard not verified.");
            if (
              JSON.stringify(readChatGPTBrowserSessions(environmentId)) !==
              JSON.stringify(sessionSnapshot)
            )
              throw new Error("T3 hierarchy changed during rollover preflight; no mutation.");
            const plan = {
              priorId,
              successorId,
              priorConversationId,
              successorConversationId,
              priorConversationUrl: oldUrl,
              archivedAt: alreadyArchived ? original.archive!.archivedAt : new Date().toISOString(),
            };
            // One local-storage update changes all direct children, successor's
            // parent/project and the predecessor archive. Grandchildren retain
            // their parents. A repeated call cannot create a new manager.
            flushSync(() => finalizeRollover(plan));
            const saved = readChatGPTBrowserSessions(environmentId);
            const savedOld = saved.find((s) => s.id === priorId);
            const savedNew = saved.find((s) => s.id === successorId);
            if (
              !savedOld?.hidden ||
              savedOld.archive?.conversationUrl !== oldUrl ||
              savedNew?.parentSessionId !== (original.parentSessionId ?? null) ||
              savedNew.project !== (original.project ?? successor.project) ||
              saved.some((s) => s.parentSessionId === priorId)
            )
              throw new Error("Rollover hierarchy persistence is unconfirmed.");
            // Use the existing archive release semantics, not permanent close.
            const threadRef = chatGPTBrowserThreadRef(environmentId, priorId);
            const previews = degraded
              ? []
              : Object.values(readThreadPreviewState(threadRef).sessions);
            for (const preview of previews) {
              beginPreviewSessionClose(threadRef, preview.tabId);
              let result;
              try {
                result = await closeChatGPTPreview({
                  environmentId,
                  input: { threadId: threadRef.threadId, tabId: preview.tabId },
                });
              } catch (error) {
                cancelPreviewSessionClose(threadRef, preview, preview.tabId);
                throw error;
              }
              if (result._tag === "Failure") {
                cancelPreviewSessionClose(threadRef, preview, preview.tabId);
                throw new Error("Archived predecessor preview could not be released.");
              }
            }
            if (!degraded) clearThreadPreviewState(threadRef);
            return {
              version: 1,
              requestId: request.requestId,
              ok: true,
              data: {
                action: "rollover_finalize",
                persisted: true,
                acknowledged: true,
                priorSessionId: priorId,
                successorSessionId: successorId,
                inheritedParentSessionId: savedNew.parentSessionId ?? null,
                inheritedProject: savedNew.project ?? null,
                transferredChildren: sessionSnapshot.filter(
                  (s) => s.parentSessionId === priorId && s.id !== successorId,
                ).length,
                predecessorArchived: true,
                guestReleased: !degraded,
                draftSafety: degraded ? "unverified_guest_retained" : "backed_up_empty",
              },
            };
          }
          console.info(`[t3-delivery-trace] ${request.requestId} ${request.action} control-start`);
          const data = await runChatGPTSessionControl({
            environmentId,
            sessions: sessionSnapshot,
            action: request.action,
            which: request.which,
            includeHidden: request.includeHidden,
            state: request.state,
            sessionId: resolvedSessionId,
            from: request.from,
            count: request.count,
            maxMessageChars: request.maxMessageChars,
            message: request.message,
            sendExpiresAt: request.sendExpiresAt,
            allowPossibleDuplicate: request.allowPossibleDuplicate,
            senderSessionId: request.senderSessionId,
            expectedConversationId: exactConversationId,
            force: request.force,
            managerDecision: request.managerDecision,
            reason: request.reason,
          });
          console.info(`[t3-delivery-trace] ${request.requestId} ${request.action} control-end`);
          if (request.action === "change_state") {
            const confirmation = data as {
              action: "change_state";
              state: "hidden" | "unhidden" | "closed";
              sessionId: string;
              alreadyInState: boolean;
              conversationUrl?: string;
            };
            const current = readChatGPTBrowserSessions(environmentId).find(
              (session) => session.id === confirmation.sessionId,
            );
            const originally = sessionSnapshot.find(
              (session) => session.id === confirmation.sessionId,
            );
            if (
              !current ||
              !originally ||
              current.hidden !== originally.hidden ||
              JSON.stringify(current.archive) !== JSON.stringify(originally.archive)
            )
              throw new Error("Target session changed during state inspection; retry.");
            if (!confirmation.alreadyInState) {
              if (confirmation.state === "closed") {
                // Same local-close semantics as the sidebar X: release only the
                // exact target's previews, then remove its T3 record and keys.
                const threadRef = chatGPTBrowserThreadRef(environmentId, confirmation.sessionId);
                const snapshots = Object.values(readThreadPreviewState(threadRef).sessions);
                for (const snapshot of snapshots) {
                  beginPreviewSessionClose(threadRef, snapshot.tabId);
                  let result;
                  try {
                    result = await closeChatGPTPreview({
                      environmentId,
                      input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
                    });
                  } catch (error) {
                    cancelPreviewSessionClose(threadRef, snapshot, snapshot.tabId);
                    throw error;
                  }
                  if (result._tag === "Failure") {
                    cancelPreviewSessionClose(threadRef, snapshot, snapshot.tabId);
                    const cause = squashAtomCommandFailure(result);
                    throw cause instanceof Error
                      ? cause
                      : new Error("Unable to close exact ChatGPT preview.");
                  }
                }
                clearThreadPreviewState(threadRef);
                flushSync(() => removeSession(confirmation.sessionId, "desktop-IPC-request"));
                removeLocalStorageItem(
                  chatGPTBrowserLastUrlKey(environmentId, confirmation.sessionId),
                );
                removeLocalStorageItem(
                  chatGPTBrowserLastWorkingKey(environmentId, confirmation.sessionId),
                );
              } else {
                if (confirmation.conversationUrl) {
                  setLocalStorageItem(
                    chatGPTBrowserLastUrlKey(environmentId, confirmation.sessionId),
                    confirmation.conversationUrl,
                    Schema.String,
                  );
                }
                flushSync(() =>
                  setSessionHidden(confirmation.sessionId, confirmation.state === "hidden"),
                );
              }
            }
            const saved = readChatGPTBrowserSessions(environmentId).find(
              (session) => session.id === confirmation.sessionId,
            );
            if (
              confirmation.state === "closed"
                ? saved !== undefined
                : !saved || (saved.hidden === true) !== (confirmation.state === "hidden")
            )
              throw new Error("Session state change was not durably persisted.");
            return {
              version: 1,
              requestId: request.requestId,
              ok: true,
              data: {
                action: "change_state",
                state: confirmation.state,
                sessionId: confirmation.sessionId,
                alreadyInState: confirmation.alreadyInState,
                persisted: true,
                acknowledged: true,
                ...(confirmation.state === "closed"
                  ? { closed: true, scope: "local-t3-session" }
                  : {}),
              },
            };
          }
          if (request.action === "archive" || request.action === "restore") {
            const confirmation = data as {
              sessionId: string;
              archive: {
                archivedAt: string;
                conversationUrl: string;
                basis: "completion" | "manager_decision";
                reason?: string;
                restoredAt?: string;
              };
              alreadyArchived?: boolean;
              alreadyRestored?: boolean;
            };
            const current = readChatGPTBrowserSessions(environmentId).find(
              (session) => session.id === confirmation.sessionId,
            );
            if (!current) throw new Error("Session vanished before persistence.");
            const lastUrlKey = chatGPTBrowserLastUrlKey(environmentId, confirmation.sessionId);
            if (request.action === "restore") {
              // Restore the exact archived conversation, never a new ChatGPT tab.
              setLocalStorageItem(lastUrlKey, confirmation.archive.conversationUrl, Schema.String);
              if (current.hidden) setSessionHidden(confirmation.sessionId, false);
              const saved = readChatGPTBrowserSessions(environmentId).find(
                (session) => session.id === confirmation.sessionId,
              );
              if (
                saved?.hidden ||
                saved?.id !== confirmation.sessionId ||
                saved?.archive?.conversationUrl !== confirmation.archive.conversationUrl ||
                getLocalStorageItem(lastUrlKey, Schema.String) !==
                  confirmation.archive.conversationUrl
              )
                throw new Error("Session restoration was not durably persisted.");
              return {
                version: 1,
                requestId: request.requestId,
                ok: true,
                data: {
                  action: "restore",
                  sessionId: confirmation.sessionId,
                  conversationUrl: confirmation.archive.conversationUrl,
                  restored: true,
                  alreadyRestored: confirmation.alreadyRestored === true,
                  persisted: true,
                  acknowledged: true,
                  reattachment: "on-render",
                },
              };
            }
            if (!confirmation.alreadyArchived) {
              // A worker can be spawned or resumed while inspections await the
              // renderer. Refuse a stale decision rather than archive its parent.
              const signature = (items: typeof sessionSnapshot) =>
                JSON.stringify(
                  items.map((entry) => ({
                    id: entry.id,
                    parentSessionId: entry.parentSessionId,
                    hidden: entry.hidden,
                    archive: entry.archive,
                    completion: entry.completion,
                  })),
                );
              if (
                signature(sessionSnapshot) !== signature(readChatGPTBrowserSessions(environmentId))
              )
                throw new Error(
                  "Session or descendant state changed during archive inspection; retry.",
                );
            }
            // Persist the archive first so unmounting the runtime prevents any
            // reopen race while its guests are being closed. Retry closes on an
            // idempotent archive call, even after an interrupted earlier attempt.
            setLocalStorageItem(lastUrlKey, confirmation.archive.conversationUrl, Schema.String);
            // Unmount the runtime before releasing the preview. Otherwise its
            // open-on-idle effect could race with our close and leak a new guest.
            if (!confirmation.alreadyArchived)
              flushSync(() => setSessionArchived(confirmation.sessionId, confirmation.archive));
            const saved = readChatGPTBrowserSessions(environmentId).find(
              (session) => session.id === confirmation.sessionId,
            );
            if (
              !saved?.hidden ||
              saved?.archive?.restoredAt ||
              saved?.archive?.conversationUrl !== confirmation.archive.conversationUrl ||
              getLocalStorageItem(lastUrlKey, Schema.String) !==
                confirmation.archive.conversationUrl
            )
              throw new Error("Session archive was not durably persisted.");
            const threadRef = chatGPTBrowserThreadRef(environmentId, confirmation.sessionId);
            const snapshots = Object.values(readThreadPreviewState(threadRef).sessions);
            for (const snapshot of snapshots) {
              beginPreviewSessionClose(threadRef, snapshot.tabId);
              let result;
              try {
                result = await closeChatGPTPreview({
                  environmentId,
                  input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
                });
              } catch (error) {
                cancelPreviewSessionClose(threadRef, snapshot, snapshot.tabId);
                throw error;
              }
              if (result._tag === "Failure") {
                cancelPreviewSessionClose(threadRef, snapshot, snapshot.tabId);
                const cause = squashAtomCommandFailure(result);
                throw cause instanceof Error
                  ? cause
                  : new Error("Could not release archived webview.");
              }
            }
            clearThreadPreviewState(threadRef);
            return {
              version: 1,
              requestId: request.requestId,
              ok: true,
              data: {
                action: "archive",
                sessionId: confirmation.sessionId,
                conversationUrl: confirmation.archive.conversationUrl,
                archive: saved.archive,
                archived: true,
                alreadyArchived: confirmation.alreadyArchived === true,
                guestReleased: true,
                persisted: true,
                acknowledged: true,
              },
            };
          }
          if (request.action === "complete") {
            const confirmation = data as {
              sessionId: string;
              completion: { declaredAt: string; observedTurns: number; observedUrl: string };
            };
            setSessionCompletion(confirmation.sessionId, confirmation.completion);
            const saved = readChatGPTBrowserSessions(environmentId).find(
              (session) => session.id === confirmation.sessionId,
            )?.completion;
            if (saved?.declaredAt !== confirmation.completion.declaredAt) {
              throw new Error("Completion declaration was not persisted.");
            }
          } else if (request.action === "send") {
            const confirmation = data as { sessionId: string; messageSent: boolean };
            if (confirmation.messageSent) setSessionCompletion(confirmation.sessionId, undefined);
          }
          if (request.action === "list") {
            const list = data as { sessions: Array<{ id: string }> };
            const known = new Map(
              readChatGPTSpawnReceipts(environmentId).map((receipt) => [
                receipt.sessionId,
                receipt.requestId,
              ]),
            );
            return {
              version: 1,
              requestId: request.requestId,
              ok: true,
              data: {
                ...list,
                sessions: list.sessions.map((entry) => ({
                  ...entry,
                  ...(known.has(entry.id) ? { spawnRequestId: known.get(entry.id) } : {}),
                })),
              },
            };
          }
          return { version: 1, requestId: request.requestId, ok: true, data };
        } catch (error) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "internal-error",
            message: error instanceof Error ? error.message : String(error),
          };
        } finally {
          if (deliveryMountSessionId)
            releaseChatGPTDeliveryMount(environmentId, deliveryMountSessionId);
        }
      }
      if (request.type === "chatgpt.reboot" || request.type === "chatgpt.refresh") {
        const environmentId = primaryEnvironment?.environmentId;
        try {
          if (!environmentId) throw new Error("Connect the Agent Reboot environment first.");
          // Hidden or startup-unloaded sessions must be materialized in their
          // existing browser slot; their previous ChatGPT state is irrelevant.
          const predecessor = readChatGPTBrowserSessions(environmentId).find(
            (item) => item.id === request.sessionId,
          );
          if (predecessor?.hidden) flushSync(() => setSessionHidden(request.sessionId, false));
          requestChatGPTDeliveryMount(environmentId, request.sessionId);
          let receipt: Awaited<ReturnType<typeof rebootChatGPTDesktop>>;
          try {
            receipt = await rebootChatGPTDesktop({
              environmentId,
              operationId: request.requestId,
              sessionId: request.sessionId,
              priorConversationId: request.priorConversationId,
              prompt: request.prompt,
              phase: request.phase,
            });
          } finally {
            releaseChatGPTDeliveryMount(environmentId, request.sessionId);
          }
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              ...(request.priorConversationId === undefined
                ? {
                    action: "reboot",
                    sessionId: receipt.sessionId,
                    rebootGeneration: receipt.generation,
                    status: receipt.status,
                  }
                : {
                    action: request.type === "chatgpt.refresh" ? "refresh" : "reboot",
                    ...receipt,
                  }),
              retrySafe: false,
            },
          };
        } catch (error) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "chatgpt-send-failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (request.type === "chatgpt.spawn") {
        const environmentId = primaryEnvironment?.environmentId;
        if (!environmentId) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "environment-unavailable",
            message: "Connect an environment before opening ChatGPT sessions.",
          };
        }
        // A generic OMCP/CLI request carries no verifiable caller identity.
        // Explicit T3 IDs alone establish ancestry. In particular, the
        // selected tab or most recent working session is NOT the caller.
        const sessions = readChatGPTBrowserSessions(environmentId);
        let parent;
        try {
          parent = resolveExplicitChatGPTParent(sessions, request.parentSessionId);
        } catch (error) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "invalid-request",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        const parentSessionId = parent?.id;
        const registered = readProjects().filter(
          (project) => project.environmentId === environmentId,
        );
        const registeredNames = registered.map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        }));
        const resolvedParent = parentSessionId
          ? applyConfirmedChatGPTSessionMetadata(sessions).find(
              (session) => session.id === parentSessionId,
            )
          : null;
        const projectHint =
          request.project ??
          resolvedParent?.project ??
          (resolvedParent
            ? matchRegisteredProject(resolvedParent.title, registeredNames)?.title
            : undefined) ??
          matchRegisteredProject(
            `${request.title} ${request.prompt.slice(0, 2000)}`,
            registeredNames,
          )?.title;
        const metadata = {
          spawnRequestId: request.requestId,
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(projectHint ? { project: projectHint } : {}),
        };
        // The reservation is persisted on this newly owned UUID before any
        // automation is allowed to touch its guest's composer.
        const sessionId = createSession(request.title, metadata);
        try {
          // Correlate the durable T3 UUID before beginning the guest prompt. If
          // the renderer detaches, a read-only sessions.list can recover it by
          // this original requestId without starting another session.
          recordChatGPTSpawnCreated(environmentId, request.requestId, sessionId);
          // ChatGPTBrowserSidebarEntry mounts a runtime for every visible
          // session, even when a different T3 route is selected. Let that
          // runtime start the new preview without navigating away from the
          // user's current editor or conversation.
          const receipt = await sendInitialChatGPTPrompt({
            environmentId,
            sessionId,
            requestId: request.requestId,
            prompt: request.prompt,
          });
          if (receipt.delivery === "user_turn_observed") {
            return {
              version: 1,
              requestId: request.requestId,
              ok: true,
              sessionId,
              messageSent: true,
              parentSessionId: parentSessionId ?? null,
            };
          }
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              action: "spawn",
              created: true,
              sessionId,
              parentSessionId: parentSessionId ?? null,
              messageSent: false,
              promptDelivery: receipt.delivery,
              sendAttempted: receipt.sendAttempted,
              ...(receipt.reason ? { reason: receipt.reason } : {}),
            },
          };
        } catch (error) {
          // A session was created; errors after that point must never erase its
          // addressability or suggest another spawn as a safe retry.
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              action: "spawn",
              created: true,
              sessionId,
              parentSessionId: parentSessionId ?? null,
              messageSent: false,
              promptDelivery: "unknown",
              sendAttempted: null,
              reason: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      return handleDesktopAppActivationRequest(request, {
        getTarget: () => {
          if (
            primaryEnvironment?.connection.phase !== "connected" ||
            primaryEnvironment.serverConfig === null
          ) {
            return null;
          }
          return {
            environmentId: primaryEnvironment.environmentId,
            platform: primaryEnvironment.serverConfig.environment.platform.os,
          };
        },
        findProject: (environmentId, workspaceRoot) =>
          findProjectByPath(
            readProjects().filter((project) => project.environmentId === environmentId),
            workspaceRoot,
          ) ?? null,
        createProject: async (environmentId, workspaceRoot) => {
          const projectId = newProjectId();
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              title: inferProjectTitleFromPath(workspaceRoot),
              workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
          }
          return projectId;
        },
        waitForProject: async (projectRef) => {
          await waitForProject(projectRef);
        },
        openThread: (projectRef) => openThread(projectRef),
      });
    },
  );

  useEffect(() => {
    if (!ready || primaryEnvironment === null || activation === undefined) return;
    const environmentId = primaryEnvironment.environmentId;
    let stopped = false;
    // The browser session inventory is desktop-local. Announce only identities
    // and currently known metadata; never wake/inspect guests or imply send
    // availability from a persisted browser tab alone.
    const publish = async () => {
      const observedAt = new Date().toISOString();
      const sessions: AgentProviderV1Session[] = readChatGPTBrowserSessions(environmentId).map(
        (entry): AgentProviderV1Session => {
          const preview = readThreadPreviewState(chatGPTBrowserThreadRef(environmentId, entry.id));
          const nav = preview.snapshot?.navStatus;
          const conversationId =
            !entry.hidden && nav?._tag === "Success" ? chatGPTConversationIdFromUrl(nav.url) : null;
          // Mount capability does not imply idle. The receiver still validates
          // the actual guest URL and activity before reading or sending.
          const loaded = !!conversationId && isLoadedChatGPTBrowserGuest(environmentId, entry);
          return {
            ref: { provider: "t3", id: entry.id },
            kind: "t3/chatgpt",
            source: { environmentId, browserSessionId: entry.id, conversationId },
            title: entry.title,
            conversation: conversationId,
            ...(entry.parentSessionId
              ? { parent: { provider: "t3", id: entry.parentSessionId } }
              : {}),
            state: {
              reachability: entry.hidden ? "Unreachable" : loaded ? "Reachable" : "Unknown",
              activity: "Unknown",
              confidence: "Unknown",
              elsewhere: null,
              observedAt,
            },
            capabilities: loaded ? ["ReadHistory", "Submit"] : [],
            deliveryModes: loaded ? ["WhenIdle"] : [],
          };
        },
      );
      const response = await publishAgentProvider({
        environmentId,
        input: {
          apiVersion: T3_AGENT_PROVIDER_VERSION,
          requestId: randomUUID(),
          method: "desktop.sessions.publish",
          params: { environmentId, sessions },
        },
      });
      if (response._tag === "Failure" && !stopped) {
        // The server may be older during staged desktop/server upgrades.
        // No retry loop or background guest activity is justified here.
      }
    };
    void publish();
    const interval = window.setInterval(() => void publish(), 30_000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [activation, ready, primaryEnvironment?.environmentId, publishAgentProvider]);

  useEffect(() => {
    if (!ready || primaryEnvironment === null || activation === undefined) return;
    const environmentId = primaryEnvironment.environmentId;
    let stopped = false;
    // The server issues a single-shot work item to exactly one authenticated
    // desktop publisher. Polling does not inspect or wake a guest on its own.
    const loop = async () => {
      while (!stopped) {
        try {
          const pulled = await publishAgentProvider({
            environmentId,
            input: {
              apiVersion: T3_AGENT_PROVIDER_VERSION,
              requestId: randomUUID(),
              method: "desktop.sessions.next",
              params: { environmentId },
            },
          });
          if (stopped) return;
          const response =
            pulled._tag === "Success" && pulled.value.ok
              ? (pulled.value.data as { work?: AgentProviderV1DesktopWork | null })
              : null;
          const work = response?.work;
          if (work && work.environmentId === environmentId) {
            const result =
              work.action === "create"
                ? await executeProviderBrowserCreate(environmentId, work, createSession)
                : await executeAgentProviderBrowserWork(environmentId, work);
            // Never re-execute a work item following failed acknowledgement.
            await publishAgentProvider({
              environmentId,
              input: {
                apiVersion: T3_AGENT_PROVIDER_VERSION,
                requestId: randomUUID(),
                method: "desktop.sessions.result",
                params: { environmentId, jobId: work.jobId, result },
              },
            });
            continue;
          }
        } catch {
          // A disconnected desktop must not attempt a guest action.
        }
        if (!stopped) await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }, [activation, ready, primaryEnvironment?.environmentId, publishAgentProvider]);

  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      const trace = (stage: string) => {
        if (request.type === "chatgpt.sessions")
          console.info(`[t3-delivery-trace] ${request.requestId} ${request.action} ${stage}`);
      };
      trace("received-v1");
      const run = async () => {
        trace("started");
        const response = await processRequest(request);
        trace("complete-called");
        await activation.complete(response);
        trace("complete-returned");
      };
      const lanes = deliveryLanesRef.current;
      const environmentId = primaryEnvironment?.environmentId;
      // Existing-recipient operations serialize per browser. A cold/slow guest
      // must not consume every other recipient's finite delivery deadline.
      // Creation and global mutations remain barriers across all active lanes.
      const sessions = environmentId ? readChatGPTBrowserSessions(environmentId) : [];
      const recipient =
        request.type === "chatgpt.sessions" &&
        ["read", "send", "reconcile_send"].includes(request.action) &&
        request.sessionId
          ? (sessions.find((session) => session.id === request.sessionId) ??
            sessions.find(
              (session) =>
                chatGPTConversationIdFromUrl(
                  getLocalStorageItem(
                    chatGPTBrowserLastUrlKey(environmentId!, session.id),
                    Schema.String,
                  ),
                ) === request.sessionId,
            ))
          : undefined;
      const recipientId =
        request.type === "chatgpt.sessions" &&
        ["read", "send", "reconcile_send"].includes(request.action)
          ? request.sessionId
          : undefined;
      if (recipientId) {
        const key = `${environmentId}:${recipient?.id ?? recipientId}`;
        const pending = Promise.all([queueRef.current, lanes.get(key)])
          .then(run)
          .catch(() => undefined);
        lanes.set(key, pending);
        void pending.then(() => {
          if (lanes.get(key) === pending) lanes.delete(key);
        });
      } else {
        queueRef.current = Promise.all([queueRef.current, ...lanes.values()])
          .then(run)
          .catch(() => undefined);
      }
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready, primaryEnvironment?.environmentId]);

  return null;
}
