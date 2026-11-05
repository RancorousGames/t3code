import { useSyncExternalStore } from "react";

export interface ChatGPTLiveTask {
  taskId: string;
  claimedBy: string;
  liveState: "ready" | "in_session" | null;
  boardRoot?: string;
  project?: string;
  withMe?: boolean;
  laterUntil?: string;
  taskTitle?: string;
  liveBrief?: string;
  liveEstMinutes?: number;
  liveReadyAt?: string;
}

let tasks: readonly ChatGPTLiveTask[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | undefined;

const notify = () => { for (const listener of listeners) listener(); };
const snapshot = () => tasks;

/** One visible-window TaskBoard read shared by the sidebar, dashboard and session brief. */
export function refreshChatGPTLiveTasks(force = false): Promise<void> {
  if (inFlight) return force ? inFlight.then(() => refreshChatGPTLiveTasks()) : inFlight;
  if (document.hidden || !window.desktopBridge?.readTaskBoardWorkerClaims) return Promise.resolve();
  inFlight = window.desktopBridge.readTaskBoardWorkerClaims()
    .then((claims) => {
      tasks = claims.filter((task) => task.withMe || task.liveState !== null);
      notify();
    })
    .catch(() => {
      // A failed read does not mean that the live queue is empty.
    })
    .finally(() => { inFlight = undefined; });
  return inFlight;
}

const onVisible = () => { void refreshChatGPTLiveTasks(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshChatGPTLiveTasks();
    timer = setInterval(() => void refreshChatGPTLiveTasks(), 60_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = undefined;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export function useChatGPTLiveTasks() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function visibleReadyChatGPTLiveTasks(all: readonly ChatGPTLiveTask[], now = Date.now()) {
  return all.filter((task) => task.liveState === "ready" &&
    (!task.laterUntil || Date.parse(task.laterUntil) <= now))
    .sort((a, b) => (Date.parse(a.liveReadyAt ?? "") || 0) -
      (Date.parse(b.liveReadyAt ?? "") || 0) || a.taskId.localeCompare(b.taskId));
}
