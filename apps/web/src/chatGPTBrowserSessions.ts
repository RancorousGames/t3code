import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { chatGPTPrewarmKey, isChatGPTHomeUrl, takeChatGPTSpare } from "./chatGPTBrowserPrewarm";
import { getLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { randomUUID } from "./lib/utils";
import { readThreadPreviewState } from "./previewStateStore";

export const BrowserSession = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  hidden: Schema.optional(Schema.Boolean),
  hiddenAt: Schema.optional(Schema.Number),
  snoozedUntil: Schema.optional(Schema.Number),
  // null explicitly detaches a child; undefined means no lineage was ever recorded.
  parentSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(Schema.String),
  completion: Schema.optional(
    Schema.Struct({
      declaredAt: Schema.String,
      observedTurns: Schema.Number,
      observedUrl: Schema.NullOr(Schema.String),
    }),
  ),
});
export type BrowserSession = typeof BrowserSession.Type;
const BrowserSessions = Schema.Array(BrowserSession);
export const chatGPTBrowserSessionsKey = (environmentId: EnvironmentId | null) =>
  `t3code:chatgpt-browser:sessions:${environmentId ?? "unconnected"}`;

/** Read the authoritative persisted snapshot during consecutive desktop requests. */
export function readChatGPTBrowserSessions(
  environmentId: EnvironmentId,
): readonly BrowserSession[] {
  return (
    getLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), BrowserSessions) ??
    INITIAL_SESSIONS
  );
}
const INITIAL_SESSIONS: readonly BrowserSession[] = [{ id: "chatgpt", title: "ChatGPT 1" }];
const DEFAULT_SESSION_TITLE = /^ChatGPT \d+$/;

export function chatGPTSessionTitleFromPage(pageTitle: string | null): string | null {
  const title = (pageTitle ?? "")
    .trim()
    .replace(/\s+[-–—|]\s+(?:ChatGPT|OpenAI)$/i, "")
    .replace(/^ChatGPT\s+[-–—|]\s+/i, "")
    .trim();
  if (!title || /^(?:ChatGPT(?: \d+)?|New chat|Temporary chat|OpenAI)$/i.test(title)) {
    return null;
  }
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

export const CHATGPT_DEFAULT_URL = "https://chatgpt.com";

export function isChatGPTConversationUrl(url: string | null): boolean {
  return chatGPTConversationIdFromUrl(url) !== null;
}

export const chatGPTBrowserLastUrlKey = (environmentId: EnvironmentId, sessionId: string) =>
  sessionId === "chatgpt"
    ? `t3code:chatgpt-browser:last-url:${environmentId}`
    : `t3code:chatgpt-browser:last-url:${environmentId}:${sessionId}`;

export const chatGPTBrowserLastWorkingKey = (environmentId: EnvironmentId, sessionId: string) =>
  `t3code:chatgpt-browser:last-working:${environmentId}:${sessionId}`;

// Preview uses this owner only to group tabs; no agent conversation is created.
export const chatGPTBrowserThreadRef = (environmentId: EnvironmentId, sessionId: string) =>
  scopeThreadRef(environmentId, ThreadId.make(`t3-browser-session:${sessionId}`));

/** Move a session within its visible or hidden section without changing the other section. */
export function reorderChatGPTSessions(
  sessions: readonly BrowserSession[],
  movingId: string,
  overId: string,
): BrowserSession[] {
  const from = sessions.findIndex((session) => session.id === movingId);
  const to = sessions.findIndex((session) => session.id === overId);
  if (from === -1 || to === -1 || from === to) return [...sessions];
  const hidden = sessions[from]?.hidden === true;
  if ((sessions[to]?.hidden === true) !== hidden) return [...sessions];
  const sectionIndices = sessions.flatMap((session, index) =>
    (session.hidden === true) === hidden ? [index] : [],
  );
  const section = sectionIndices.map((index) => sessions[index]!);
  const source = section.findIndex((session) => session.id === movingId);
  const target = section.findIndex((session) => session.id === overId);
  if (source === -1 || target === -1) return [...sessions];
  const [removed] = section.splice(source, 1);
  section.splice(target, 0, removed!);
  const reordered = [...sessions];
  sectionIndices.forEach((index, position) => {
    reordered[index] = section[position]!;
  });
  return reordered;
}

/** Hiding prepends to the hidden list; restoring appends to the live list. */
export function setChatGPTSessionHidden(
  sessions: readonly BrowserSession[],
  id: string,
  hidden: boolean,
): BrowserSession[] {
  const target = sessions.find((session) => session.id === id);
  if (!target || (target.hidden === true) === hidden) return [...sessions];

  const remaining = sessions.filter((session) => session.id !== id);
  const visible = remaining.filter((session) => session.hidden !== true);
  const hiddenSessions = remaining.filter((session) => session.hidden === true);
  const updated = { ...target, hidden, hiddenAt: hidden ? Date.now() : undefined };
  return [...visible, updated, ...hiddenSessions];
}

export const CHATGPT_HIDDEN_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

/** Unknown legacy hide times are never treated as expired. */
export function expiredHiddenSessionIds(
  sessions: readonly BrowserSession[],
  now: number,
): string[] {
  return sessions
    .filter(
      (session) =>
        session.hidden === true &&
        typeof session.hiddenAt === "number" &&
        Number.isFinite(session.hiddenAt) &&
        session.hiddenAt > 0 &&
        now - session.hiddenAt >= CHATGPT_HIDDEN_EXPIRY_MS,
    )
    .map((session) => session.id);
}

export function useChatGPTBrowserSessions(environmentId: EnvironmentId | null) {
  const [sessions, setSessions] = useLocalStorage(
    chatGPTBrowserSessionsKey(environmentId),
    INITIAL_SESSIONS,
    BrowserSessions,
  );
  const [prewarmedSessionId, setPrewarmedSessionId] = useLocalStorage(
    chatGPTPrewarmKey(environmentId ?? "unconnected"),
    "",
    Schema.String,
  );

  const createSession = useCallback(
    (name?: string, metadata?: { parentSessionId?: string; project?: string }) => {
      let id = randomUUID();
      // Read the current slot synchronously: multiple buttons, the palette and
      // desktop automation can request sessions without waiting for a render.
      if (environmentId) {
        const spareId = getLocalStorageItem(chatGPTPrewarmKey(environmentId), Schema.String);
        if (spareId) {
          const threadRef = chatGPTBrowserThreadRef(environmentId, spareId);
          const state = readThreadPreviewState(threadRef);
          const tabId = state.activeTabId;
          const nav = tabId ? state.sessions[tabId]?.navStatus : null;
          const overlay = tabId ? state.desktopByTabId[tabId] : null;
          const attached =
            !!tabId &&
            !!state.serverEpoch &&
            Array.from(document.querySelectorAll("webview")).some(
              (element) =>
                element.dataset.previewTab ===
                previewRuntimeTabId(threadRef, state.serverEpoch, tabId),
            );
          if (
            !sessions.some((session) => session.id === spareId) &&
            nav?._tag === "Success" &&
            isChatGPTHomeUrl(nav.url) &&
            overlay?.hasWebContents &&
            !overlay.loading &&
            attached &&
            takeChatGPTSpare(environmentId, spareId)
          ) {
            id = spareId;
            // The consumed webview remains mounted under its original preview
            // owner; replenishment gets a different owner and a fresh page.
            setPrewarmedSessionId(randomUUID());
          }
        }
      }
      setSessions((current) => {
        let number = 1;
        while (current.some((session) => session.title === `ChatGPT ${number}`)) number += 1;
        return [
          ...current,
          {
            id,
            title: name?.trim() || `ChatGPT ${number}`,
            ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
            ...(metadata?.project ? { project: metadata.project } : {}),
          },
        ];
      });
      return id;
    },
    [environmentId, sessions, setPrewarmedSessionId, setSessions],
  );

  const setSessionCompletion = useCallback(
    (id: string, completion: BrowserSession["completion"] | undefined) => {
      setSessions((current) =>
        current.map((session) => (session.id === id ? { ...session, completion } : session)),
      );
    },
    [setSessions],
  );

  const setSessionParent = useCallback(
    (id: string, parentId: string | null) => {
      setSessions((current) => {
        if (parentId === id) return current;
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        if (parentId && !byId.has(parentId)) return current;
        let cursor = parentId;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === id || seen.has(cursor)) return current;
          seen.add(cursor);
          cursor = byId.get(cursor)?.parentSessionId ?? null;
        }
        return current.map((session) =>
          session.id === id
            ? {
                ...session,
                parentSessionId: parentId,
                project: parentId
                  ? (byId.get(parentId)?.project ?? session.project)
                  : session.project,
              }
            : session,
        );
      });
    },
    [setSessions],
  );

  const setSessionProject = useCallback(
    (id: string, project: string | null) =>
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? { ...session, project: project ?? "Other", parentSessionId: null }
            : session,
        ),
      ),
    [setSessions],
  );

  const setSessionSnooze = useCallback(
    (ids: readonly string[], until: number | null) => {
      const targets = new Set(ids);
      setSessions((current) =>
        current.map((session) =>
          targets.has(session.id) ? { ...session, snoozedUntil: until ?? undefined } : session,
        ),
      );
    },
    [setSessions],
  );

  const syncInferredMetadata = useCallback(
    (
      updates: ReadonlyArray<{
        readonly id: string;
        readonly project?: string | undefined;
        readonly parentSessionId?: string | undefined;
      }>,
    ) => {
      const byId = new Map(updates.map((entry) => [entry.id, entry]));
      setSessions((current) => {
        let changed = false;
        const next = current.map((session) => {
          const update = byId.get(session.id);
          if (!update) return session;
          const project = session.project ?? update.project;
          const parentSessionId =
            session.parentSessionId === undefined
              ? update.parentSessionId
              : session.parentSessionId;
          if (project === session.project && parentSessionId === session.parentSessionId)
            return session;
          changed = true;
          return {
            ...session,
            ...(project ? { project } : {}),
            ...(parentSessionId ? { parentSessionId } : {}),
          };
        });
        return changed ? next : current;
      });
    },
    [setSessions],
  );

  const pruneExpiredHidden = useCallback(
    (now: number) => {
      const expired = expiredHiddenSessionIds(sessions, now);
      if (!expired.length) return [] as string[];
      const ids = new Set(expired);
      setSessions((current) =>
        current
          .filter((session) => !ids.has(session.id))
          .map((session) =>
            session.parentSessionId && ids.has(session.parentSessionId)
              ? { ...session, parentSessionId: null }
              : session,
          ),
      );
      return expired;
    },
    [sessions, setSessions],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setSessions((current) =>
        current.map((session) => (session.id === id ? { ...session, title: trimmed } : session)),
      );
    },
    [setSessions],
  );

  const renameSessionFromPageTitle = useCallback(
    (id: string, pageTitle: string | null) => {
      const title = chatGPTSessionTitleFromPage(pageTitle);
      if (!title) return;
      setSessions((current) =>
        current.map((session) =>
          session.id === id && DEFAULT_SESSION_TITLE.test(session.title)
            ? { ...session, title }
            : session,
        ),
      );
    },
    [setSessions],
  );

  const removeSession = useCallback(
    (id: string) =>
      setSessions((current) =>
        current
          .filter((session) => session.id !== id)
          .map((session) =>
            session.parentSessionId === id ? { ...session, parentSessionId: null } : session,
          ),
      ),
    [setSessions],
  );

  const reorderSessions = useCallback(
    (movingId: string, overId: string) =>
      setSessions((current) => reorderChatGPTSessions(current, movingId, overId)),
    [setSessions],
  );

  const setSessionHidden = useCallback(
    (id: string, hidden: boolean) =>
      setSessions((current) => setChatGPTSessionHidden(current, id, hidden)),
    [setSessions],
  );

  return {
    sessions,
    prewarmedSessionId,
    setPrewarmedSessionId,
    createSession,
    reorderSessions,
    renameSession,
    renameSessionFromPageTitle,
    removeSession,
    setSessionHidden,
    setSessionProject,
    setSessionParent,
    setSessionSnooze,
    setSessionCompletion,
    syncInferredMetadata,
    pruneExpiredHidden,
  };
}
