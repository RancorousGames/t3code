import { useEffect, useRef } from "react";
import type { NavigateFn } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { toastManager } from "./components/ui/toast";
import {
  refreshChatGPTLiveTasks,
  visibleReadyChatGPTLiveTasks,
  type ChatGPTLiveTask,
} from "./chatGPTLiveTasks";

const SEEN_KEY = "t3code:chatgpt:ready-nudged:v1";
const ACTIVE_KEY = "t3code:chatgpt:last-human-activity:v1";
const ACTIVE_WINDOW = 5 * 60_000;
const RETURN_WINDOW = 30 * 60_000;

function seenKeys(): Set<string> {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function readyKey(task: ChatGPTLiveTask) {
  return `${task.boardRoot ?? task.project ?? ""}:${task.taskId}:${task.liveReadyAt ?? ""}`;
}

/** A single app-level nudge owner, mounted beside the ChatGPT sidebar. */
export function useChatGPTReadyNudge(
  tasks: readonly ChatGPTLiveTask[],
  environmentId: EnvironmentId | null | undefined,
  navigate: NavigateFn,
) {
  const latest = useRef({ tasks, environmentId, navigate });
  latest.current = { tasks, environmentId, navigate };
  const readyToSummarize = useRef(false);
  const evaluateRef = useRef<() => void>(() => {});
  const lastActive = useRef(Number(localStorage.getItem(ACTIVE_KEY)) || 0);
  const seen = useRef(seenKeys());

  useEffect(() => {
    const evaluate = () => {
      if (document.hidden || !document.hasFocus() || !latest.current.environmentId) return;
      const now = Date.now();
      if (now - lastActive.current > ACTIVE_WINDOW) return;
      const eligible = visibleReadyChatGPTLiveTasks(latest.current.tasks, now)
        .filter((task) => task.boardRoot && !seen.current.has(readyKey(task)));
      if (!eligible.length) return;
      for (const task of eligible) seen.current.add(readyKey(task));
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current].slice(-2000)));
      const summary = readyToSummarize.current;
      readyToSummarize.current = false;
      const id = toastManager.add({
        type: "info",
        title: `${eligible.length} ${eligible.length === 1 ? "task is" : "tasks are"} ready to work with you`,
        description: summary ? "Ready tasks collected while you were away." : undefined,
        actionProps: {
          children: "Start next",
          onClick: () => {
            toastManager.close(id);
            const task = eligible[0]!;
            const bridge = window.desktopBridge;
            const env = latest.current.environmentId;
            if (!task.boardRoot || !bridge?.openTaskBoardLiveSession || !env) return;
            void bridge.openTaskBoardLiveSession({
              boardRoot: task.boardRoot, taskId: task.taskId, environmentId: env,
            }).then(async (receipt) => {
              await refreshChatGPTLiveTasks(true);
              if (receipt.sessionId) {
                await latest.current.navigate({
                  to: "/browser/$browserSessionId",
                  params: { browserSessionId: receipt.sessionId },
                });
              }
            }).catch((error: unknown) => toastManager.add({
              type: "error", title: "Could not open live task", description: String(error),
            }));
          },
        },
        data: {
          secondaryActionProps: {
            children: "Later",
            onClick: () => {
              toastManager.close(id);
              const bridge = window.desktopBridge;
              if (!bridge?.controlTaskBoardLiveSession) return;
              void Promise.allSettled(eligible.map((task) => bridge.controlTaskBoardLiveSession!({
                boardRoot: task.boardRoot!, taskId: task.taskId, action: "later",
                until: new Date(Date.now() + 60 * 60_000).toISOString(),
              }))).then(() => refreshChatGPTLiveTasks(true));
            },
          },
        },
      });
    };

    evaluateRef.current = evaluate;
    const markActive = () => {
      if (document.hidden || !document.hasFocus()) return;
      const now = Date.now();
      if (lastActive.current && now - lastActive.current >= RETURN_WINDOW) {
        readyToSummarize.current = true;
      }
      lastActive.current = now;
      localStorage.setItem(ACTIVE_KEY, String(now));
      evaluate();
    };
    const onFocus = () => { if (!document.hidden) markActive(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", markActive);
    // Pointer movement counts as presence, but avoids per-frame storage writes.
    let lastMovementAt = 0;
    const onMove = () => {
      if (Date.now() - lastMovementAt < 30_000) return;
      lastMovementAt = Date.now();
      markActive();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", markActive);
    document.addEventListener("visibilitychange", onFocus);
    evaluate();
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", markActive);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // A TaskBoard refresh can reveal new ready tasks while Jacob is using T3.
  useEffect(() => {
    if (document.hidden || !document.hasFocus()) return;
    if (Date.now() - lastActive.current > ACTIVE_WINDOW) return;
    evaluateRef.current();
  }, [tasks]);
}
