import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  BrowserSessions,
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserRemovalAuditKey,
  chatGPTBrowserSessionsKey,
  type BrowserSession,
  type ChatGPTSessionRemovalSource,
} from "./chatGPTBrowserSessions";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { setLocalStorageItem } from "./hooks/useLocalStorage";

export const CHATGPT_CLOSE_UNDO_MS = 60_000;
const MAX_RECENT_CLOSES = 5;
const undoKey = (environmentId: string) =>
  `t3code:chatgpt-browser:recently-closed:v1:${environmentId}`;

type ClosedSession = {
  session: BrowserSession;
  url: string | null;
  children: string[];
  removedAt: string;
};

function readHistory(environmentId: string): ClosedSession[] {
  try {
    const entries: unknown = JSON.parse(
      window.localStorage.getItem(undoKey(environmentId)) ?? "[]",
    );
    if (!Array.isArray(entries)) return [];
    return entries.filter((value): value is ClosedSession => {
      if (!value || typeof value !== "object") return false;
      const entry = value as Partial<ClosedSession>;
      return (
        !!entry.session &&
        typeof entry.session.id === "string" &&
        typeof entry.session.title === "string" &&
        typeof entry.removedAt === "string" &&
        (entry.url === null || typeof entry.url === "string") &&
        Array.isArray(entry.children) &&
        entry.children.every((id) => typeof id === "string")
      );
    });
  } catch {
    return [];
  }
}

function readAudit(environmentId: string): Record<string, unknown>[] | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(chatGPTBrowserRemovalAuditKey(environmentId as EnvironmentId)) ??
        "[]",
    );
    return Array.isArray(value) && value.every((entry) => entry && typeof entry === "object")
      ? (value as Record<string, unknown>[])
      : null;
  } catch {
    return null;
  }
}

function isRecent(removedAt: string, now: number): boolean {
  const time = Date.parse(removedAt);
  return Number.isFinite(time) && now >= time && now - time < CHATGPT_CLOSE_UNDO_MS;
}

/** Keep a bounded, durable inverse of a successful human close (not an agent cleanup). */
export function rememberClosedChatGPTSession(
  environmentId: EnvironmentId,
  session: BrowserSession,
  url: string | null,
  childIds: readonly string[],
  source: ChatGPTSessionRemovalSource,
): void {
  if (source !== "desktop-menu-action" && source !== "sidebar-user-action") return;
  const audit = readAudit(environmentId);
  const receipt = audit?.findLast(
    (entry) =>
      entry.sessionId === session.id &&
      entry.source === source &&
      typeof entry.removedAt === "string" &&
      isRecent(entry.removedAt, Date.now()),
  );
  if (!receipt) return;
  const removedAt = receipt.removedAt as string;
  const history = readHistory(environmentId).filter(
    (entry) => entry.session.id !== session.id && isRecent(entry.removedAt, Date.now()),
  );
  history.push({ session, url, children: [...childIds], removedAt });
  window.localStorage.setItem(
    undoKey(environmentId),
    JSON.stringify(history.slice(-MAX_RECENT_CLOSES)),
  );
}

export function canUndoClosedChatGPTSession(environmentId: EnvironmentId): boolean {
  const audit = readAudit(environmentId);
  if (!audit) return false;
  return readHistory(environmentId).some(
    (entry) =>
      isRecent(entry.removedAt, Date.now()) &&
      audit.some(
        (receipt) =>
          receipt.sessionId === entry.session.id && receipt.removedAt === entry.removedAt,
      ),
  );
}

/** Remove the close receipt before restoring the original T3 UUID and metadata. */
export function undoClosedChatGPTSession(environmentId: EnvironmentId): string | null {
  const audit = readAudit(environmentId);
  if (!audit) return null;
  const history = readHistory(environmentId);
  while (history.length) {
    const entry = history.pop()!;
    if (!isRecent(entry.removedAt, Date.now())) continue;
    const receiptIndex = audit.findIndex(
      (item) => item.sessionId === entry.session.id && item.removedAt === entry.removedAt,
    );
    if (receiptIndex === -1) continue;
    const store = getChatGPTSessionPersistedStore(environmentId);
    const existing = store.getState().sessions;
    if (existing.some((session) => session.id === entry.session.id)) continue;

    // A stale renderer must not treat an undone close as authoritative evidence.
    const updatedAudit = audit.filter((_, index) => index !== receiptIndex);
    window.localStorage.setItem(
      chatGPTBrowserRemovalAuditKey(environmentId),
      JSON.stringify(updatedAudit),
    );
    const next = [
      ...existing.map((session) =>
        entry.children.includes(session.id) && !session.parentSessionId
          ? { ...session, parentSessionId: entry.session.id }
          : session,
      ),
      entry.session,
    ];
    setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
    store.setState({ sessions: next });
    if (entry.url)
      setLocalStorageItem(
        chatGPTBrowserLastUrlKey(environmentId, entry.session.id),
        entry.url,
        Schema.String,
      );
    window.localStorage.setItem(undoKey(environmentId), JSON.stringify(history));
    return entry.session.id;
  }
  window.localStorage.setItem(undoKey(environmentId), JSON.stringify(history));
  return null;
}
