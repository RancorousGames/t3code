import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTBrowserLastWorkingKey } from "./chatGPTBrowserSessions";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";

// Store the two newer observations separately from the sidebar session array:
// a working ChatGPT guest can produce frequent heartbeats without rewriting
// the complete session list. Existing last-working history remains authoritative.
const timeKey = (environmentId: string, sessionId: string, kind: "active" | "refresh" | "reboot") =>
  `t3code:chatgpt-browser:last-${kind}:${environmentId}:${sessionId}`;

function readTime(key: string): number | null {
  try {
    const value = getLocalStorageItem(key, Schema.Number);
    return value && Number.isFinite(value) && value > 0 && value <= Date.now() ? value : null;
  } catch {
    return null;
  }
}

function recordTime(environmentId: string, sessionId: string, kind: "active" | "refresh" | "reboot", at: number): void {
  const key = timeKey(environmentId, sessionId, kind);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now()) return;
  const previous = readTime(key);
  if (previous !== null && previous >= at) return;
  try {
    setLocalStorageItem(key, at, Schema.Number);
    const store = getChatGPTSessionPersistedStore(environmentId);
    store.setState((state) => {
      const entry = state.timeline[sessionId] ?? {};
      if ((entry[kind] ?? 0) >= at) return state;
      return { timeline: { ...state.timeline, [sessionId]: { ...entry, [kind]: at } } };
    });
  } catch {
    // A storage outage must not obstruct opening or refreshing a session.
  }
}

/** Explicit user selection (not mount, hibernation or periodic polling). */
export function recordChatGPTSessionActiveAt(
  environmentId: string,
  sessionId: string,
  at = Date.now(),
): void {
  recordTime(environmentId, sessionId, "active", at);
}

/** Browser page reload recovery only; an Agent Reboot starts a new ChatGPT conversation. */
export function recordChatGPTSessionRefreshedAt(
  environmentId: string,
  sessionId: string,
  at = Date.now(),
): void {
  recordTime(environmentId, sessionId, "refresh", at);
}

/** Record a verified same-seat Agent Reboot, not an ordinary browser reload. */
export function recordChatGPTSessionRebootedAt(
  environmentId: string,
  sessionId: string,
  at = Date.now(),
): void {
  recordTime(environmentId, sessionId, "reboot", at);
}

export function readChatGPTSessionTimeline(
  environmentId: string,
  session: BrowserSession,
  observedLastWorkingAt?: number,
  verifiedSpawnCreatedAt?: number,
): {
  createdAt: number | null;
  lastActiveAt: number | null;
  lastRefreshAt: number | null;
  lastRebootAt: number | null;
} {
  const createdAt = session.createdAt ?? verifiedSpawnCreatedAt;
  const working =
    observedLastWorkingAt && Number.isFinite(observedLastWorkingAt) && observedLastWorkingAt > 0
      ? observedLastWorkingAt
      : (readTime(chatGPTBrowserLastWorkingKey(EnvironmentId.make(environmentId), session.id)) ??
        0);
  const timeline = getChatGPTSessionPersistedStore(environmentId).getState().timeline[session.id];
  const active = timeline?.active ?? 0;
  const lastActiveAt = Math.max(
    Number.isFinite(working) && working > 0 && working <= Date.now() ? working : 0,
    active,
  );
  return {
    // Older sessions have no reliable creation record. Never infer one from
    // mount, first observation, UUID, or modification of their title/project.
    createdAt:
      typeof createdAt === "number" &&
      Number.isFinite(createdAt) &&
      createdAt > 0 &&
      createdAt <= Date.now()
        ? createdAt
        : null,
    lastActiveAt: lastActiveAt > 0 ? lastActiveAt : null,
    lastRefreshAt: timeline?.refresh ?? null,
    lastRebootAt: timeline?.reboot ?? null,
  };
}

export function formatChatGPTSessionDateTime(at: number | null): string {
  return at === null
    ? "Unknown (not recorded)"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at);
}
