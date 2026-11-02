import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { canonicalChatGPTLink } from "./chatGPTExternalLinkRouting";

export type T3SmartLink =
  | { kind: "conversation"; url: string }
  | { kind: "session"; sessionId: string }
  | { kind: "taskboard"; mode: "task" | "review"; taskId: string; board?: string }
  | { kind: "presentation"; url: string }
  | { kind: "wartribes-tour"; scenario: string };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Z][A-Z0-9]{1,12}-[0-9]{3,7}$/;

/**
 * Stable, plain HTTP URLs for ChatGPT to emit as clickable Markdown:
 *   http://localhost:3333/t3/session/<T3_UUID>
 *   http://localhost:3333/t3/task/T3-0224?board=t3code
 *   http://localhost:3333/t3/review/WT-0001?board=Wartribes
 *   http://localhost:3333/presentations/view/<presentation>
 *   http://localhost:3333/t3/tour/m1
 *
 * Never execute arbitrary localhost URLs or forward credentials to desktop IPC.
 */
export function parseT3SmartLink(value: string): T3SmartLink | null {
  const conversation = canonicalChatGPTLink(value);
  if (conversation) return { kind: "conversation", url: conversation };
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) ||
        !["http:", "https:"].includes(url.protocol) || url.port !== "3333" ||
        url.username || url.password) return null;
    if (url.pathname.startsWith("/presentations/"))
      return { kind: "presentation", url: url.href };
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "t3") return null;
    if (parts[1] === "tour" && /^[a-z][a-z0-9_]{0,70}$/.test(parts[2]!))
      return { kind: "wartribes-tour", scenario: parts[2]! };
    if (parts[1] === "session" && UUID.test(parts[2]!))
      return { kind: "session", sessionId: parts[2]! };
    if ((parts[1] === "task" || parts[1] === "review") && TASK_ID.test(parts[2]!)) {
      const board = url.searchParams.get("board") ?? undefined;
      return {
        kind: "taskboard",
        mode: parts[1] as "task" | "review",
        taskId: parts[2]!,
        ...(board ? { board } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Both Browser and Session surfaces resolve these links identically. */
export function useChatGPTSmartLinks(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const { sessions, createSession, setSessionHidden, setSessionSnooze } =
    useChatGPTBrowserSessions(environmentId);
  return useCallback(async (url: string): Promise<boolean> => {
    const link = parseT3SmartLink(url);
    if (!link) return false;
    if (link.kind === "taskboard") {
      const open = window.desktopBridge?.openTaskBoardLink;
      if (!open) throw new Error("Update the T3 desktop app to open TaskBoard links.");
      await open({
        taskId: link.taskId, mode: link.mode,
        ...(link.board ? { board: link.board } : {}),
      });
      return true;
    }
    if (link.kind === "wartribes-tour") {
      const launch = window.desktopBridge?.openWartribesTour;
      if (!launch) throw new Error("Update T3 to launch Wartribes tours.");
      await launch(link.scenario);
      return true;
    }
    if (link.kind === "presentation") {
      if (window.desktopBridge?.openFirefoxLink)
        await window.desktopBridge.openFirefoxLink(link.url);
      else if (window.desktopBridge?.openExternal)
        await window.desktopBridge.openExternal(link.url);
      else throw new Error("Desktop browser launcher unavailable.");
      return true;
    }
    if (!environmentId) throw new Error("Local T3 environment unavailable.");
    let targetId: string;
    if (link.kind === "conversation") {
      targetId = createSession(undefined, { initialConversationUrl: link.url });
    } else {
      const session = sessions.find((entry) => entry.id === link.sessionId);
      if (!session) throw new Error(`T3 session ${link.sessionId} is not registered here.`);
      if (session.hidden) setSessionHidden(session.id, false);
      if ((session.snoozedUntil ?? 0) > Date.now()) setSessionSnooze([session.id], null);
      targetId = session.id;
    }
    await navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: targetId } });
    return true;
  }, [environmentId, navigate, sessions, createSession, setSessionHidden, setSessionSnooze]);
}
