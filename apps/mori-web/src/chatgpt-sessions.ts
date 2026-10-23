import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";

export interface MoriChatSession {
  id: string;
  title: string;
  url: string;
  hidden: boolean;
  projectId: string;
  changedAt: number;
}
const STORAGE_KEY = "mori.chatgpt-sessions.v1";
const DEFAULT_URL = "https://chatgpt.com/";

export function normalizedChatGPTUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(parsed.hostname)) return null;
    if (parsed.pathname === "/" || parsed.pathname === "/") return DEFAULT_URL;
    return chatGPTConversationIdFromUrl(parsed.href) ? `https://chatgpt.com/c/${chatGPTConversationIdFromUrl(parsed.href)}` : null;
  } catch {
    return null;
  }
}
export function createChatSession(projectId: string): MoriChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New ChatGPT chat",
    url: DEFAULT_URL,
    projectId,
    hidden: false,
    changedAt: Date.now(),
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
    result.push({
      id: item.id, title: item.title.slice(0, 100), projectId: item.projectId,
      url, hidden: item.hidden === true,
      changedAt: typeof item.changedAt === "number" ? item.changedAt : 0,
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
