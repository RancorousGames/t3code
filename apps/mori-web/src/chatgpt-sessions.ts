import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";

/** Mori keeps its own sessions and browser profile, never mutating T3 sessions.
 * Visual conventions and context-menu metadata are shared with T3 Code. */
export type MoriChatActivity = "loading" | "working" | "idle" | "unknown" | "interrupted" | "invalid" | "unloaded";

export interface MoriChatSession {
  id: string;
  title: string;
  url: string;
  hidden: boolean;
  projectId: string;
  changedAt: number;
  createdAt?: number | undefined;
  lastDirectInteractionAt?: number | undefined;
  lastWorkingAt?: number | undefined;
  lastSeenAt?: number | undefined;
  activity?: MoriChatActivity | undefined;
  snoozedUntil?: number | undefined;
  quickSnoozeStep?: number | undefined;
  borderColor?: string | undefined;
  verificationPending?: boolean | undefined;
  markedAsWorkerAt?: number | undefined;
  humanControlled?: boolean | undefined;
  /** Optional sidebar group, distinct from Mori's owning translation project. */
  project?: string | undefined;
  parentSessionId?: string | null | undefined;
  titleSource?: "user" | "bootstrap" | undefined;
}
const STORAGE_KEY = "mori.chatgpt-sessions.v1";
const DEFAULT_URL = "https://chatgpt.com/";

export function normalizedChatGPTUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(parsed.hostname)) return null;
    if (parsed.pathname === "/" || parsed.pathname === "") return DEFAULT_URL;
    const id = chatGPTConversationIdFromUrl(parsed.href);
    return id ? `https://chatgpt.com/c/${id}` : null;
  } catch {
    return null;
  }
}

export function createChatSession(projectId: string): MoriChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New ChatGPT chat",
    url: DEFAULT_URL,
    projectId,
    hidden: false,
    changedAt: now,
    createdAt: now,
    lastDirectInteractionAt: now,
    activity: "loading",
  };
}
export function deserializeChatSessions(raw: unknown): MoriChatSession[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: MoriChatSession[] = [];
  for (const item of raw.slice(0, 300)) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" ||
        typeof item.title !== "string" || typeof item.projectId !== "string" ||
        typeof item.url !== "string" || seen.has(item.id)) continue;
    const url = normalizedChatGPTUrl(item.url);
    if (!url) continue;
    seen.add(item.id);
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    const activity = ["loading", "working", "idle", "unknown", "interrupted", "invalid", "unloaded"]
      .includes(item.activity) ? item.activity as MoriChatActivity : undefined;
    result.push({
      id: item.id, title: item.title.slice(0, 100), projectId: item.projectId,
      url, hidden: item.hidden === true,
      changedAt: num(item.changedAt) ?? 0,
      ...(num(item.createdAt) !== undefined ? { createdAt: num(item.createdAt) } : {}),
      ...(num(item.lastDirectInteractionAt) !== undefined ? { lastDirectInteractionAt: num(item.lastDirectInteractionAt) } : {}),
      ...(num(item.lastWorkingAt) !== undefined ? { lastWorkingAt: num(item.lastWorkingAt) } : {}),
      ...(num(item.lastSeenAt) !== undefined ? { lastSeenAt: num(item.lastSeenAt) } : {}),
      ...(num(item.snoozedUntil) !== undefined ? { snoozedUntil: num(item.snoozedUntil) } : {}),
      ...(num(item.quickSnoozeStep) !== undefined ? { quickSnoozeStep: num(item.quickSnoozeStep) } : {}),
      ...(activity ? { activity } : {}),
      ...(typeof item.borderColor === "string" ? { borderColor: item.borderColor.slice(0, 20) } : {}),
      ...(item.verificationPending === true ? { verificationPending: true } : {}),
      ...(num(item.markedAsWorkerAt) !== undefined ? { markedAsWorkerAt: num(item.markedAsWorkerAt) } : {}),
      ...(item.humanControlled === true ? { humanControlled: true } : {}),
      ...(typeof item.project === "string" ? { project: item.project.slice(0, 100) } : {}),
      ...(typeof item.parentSessionId === "string" || item.parentSessionId === null ? { parentSessionId: item.parentSessionId } : {}),
      ...(item.titleSource === "user" ? { titleSource: "user" as const } : {}),
    });
  }
  return result;
}
export function loadChatSessions(): MoriChatSession[] {
  try {
    return deserializeChatSessions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch { return []; }
}
export function saveChatSessions(sessions: MoriChatSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}
