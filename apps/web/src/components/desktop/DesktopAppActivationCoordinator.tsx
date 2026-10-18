import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";

import { sendInitialChatGPTPrompt } from "../../chatGPTBrowserAutomation";
import { runChatGPTSessionControl } from "../../chatGPTSessionControl";
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

import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { readProjects, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const { createSession, setSessionCompletion } = useChatGPTBrowserSessions(
    primaryEnvironment?.environmentId ?? null,
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const queueRef = useRef(Promise.resolve());
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
      if (request.type === "chatgpt.sessions") {
        const environmentId = primaryEnvironment?.environmentId;
        if (!environmentId)
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "environment-unavailable",
            message: "Connect an environment first.",
          };
        try {
          const data = await runChatGPTSessionControl({
            environmentId,
            sessions: readChatGPTBrowserSessions(environmentId),
            action: request.action,
            which: request.which,
            sessionId: request.sessionId,
            from: request.from,
            count: request.count,
            maxMessageChars: request.maxMessageChars,
            message: request.message,
            senderSessionId: request.senderSessionId,
            expectedConversationId: request.expectedConversationId,
            force: request.force,
          });
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
          return { version: 1, requestId: request.requestId, ok: true, data };
        } catch (error) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "internal-error",
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
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(projectHint ? { project: projectHint } : {}),
        };
        const sessionId = Object.keys(metadata).length
          ? createSession(request.title, metadata)
          : createSession(request.title);
        try {
          // ChatGPTBrowserSidebarEntry mounts a runtime for every visible
          // session, even when a different T3 route is selected. Let that
          // runtime start the new preview without navigating away from the
          // user's current editor or conversation.
          await sendInitialChatGPTPrompt({ environmentId, sessionId, prompt: request.prompt });
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            sessionId,
            messageSent: true,
            parentSessionId: parentSessionId ?? null,
          };
        } catch (error) {
          // Keep the named session and any unsent draft visible for recovery.
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "chatgpt-send-failed",
            message:
              error instanceof Error ? error.message : "Could not send ChatGPT's initial message.",
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
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
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
  }, [activation, ready]);

  return null;
}
