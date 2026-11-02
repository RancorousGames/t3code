import { useMemo, useSyncExternalStore } from "react";

/** A single pending human question belongs to a T3 browser session, not a
 * ChatGPT conversation URL. Bootstrap IDs do not grant rights over other tabs. */
export interface ChatGPTSessionQuestion {
  id: string;
  prompt: string;
  options: string[];
  allowCustom: boolean;
  askedAt: number;
  status: "pending" | "answered";
  answer?: string;
  answerMessageId?: string;
  answeredAt?: number;
}

const EVENT = "t3:chatgpt-session-question-changed";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const keyFor = (environmentId: string, sessionId: string) =>
  `t3code:chatgpt-browser:session-question:v1:${environmentId}:${sessionId}`;

function readRaw(key: string, storage: Storage | undefined) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function parse(raw: string | null): ChatGPTSessionQuestion | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const q = value as Partial<ChatGPTSessionQuestion>;
    if (typeof q.id !== "string" || !UUID.test(q.id) ||
        typeof q.prompt !== "string" || !q.prompt.trim() || q.prompt.length > 4000 ||
        !Array.isArray(q.options) || q.options.length > 8 ||
        !q.options.every(s => typeof s === "string" && !!s.trim() && s.length <= 180) ||
        typeof q.allowCustom !== "boolean" || !Number.isFinite(q.askedAt) ||
        !["pending", "answered"].includes(q.status ?? "")) return null;
    if (q.status === "answered" &&
        (typeof q.answer !== "string" || typeof q.answerMessageId !== "string")) return null;
    return q as ChatGPTSessionQuestion;
  } catch { return null; }
}

export function readChatGPTSessionQuestion(environmentId: string, sessionId: string, storage?: Storage) {
  try { return parse(readRaw(keyFor(environmentId, sessionId), storage ?? window.localStorage)); }
  catch { return null; }
}

function writeQuestion(environmentId: string, sessionId: string, question: ChatGPTSessionQuestion, storage: Storage) {
  storage.setItem(keyFor(environmentId, sessionId), JSON.stringify(question));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: keyFor(environmentId, sessionId) }));
}

/** Idempotent request: reusing an operation ID cannot overwrite a different
 * pending question or implicitly answer it. */
export function requestChatGPTSessionQuestion(
  environmentId: string, sessionId: string,
  input: { id: string; prompt: string; options?: string[]; allowCustom?: boolean },
  storage: Storage = window.localStorage, now = Date.now(),
): ChatGPTSessionQuestion {
  const prompt = input.prompt.trim();
  const options = (input.options ?? []).map(option => option.trim());
  if (!UUID.test(input.id) || !prompt || prompt.length > 4000 ||
      options.length > 8 || new Set(options).size !== options.length ||
      options.some(option => !option || option.length > 180) ||
      (options.length === 0 && input.allowCustom === false))
    throw new Error("A question requires a UUID, 1..4000 characters, up to eight options and a permitted answer.");
  const previous = readChatGPTSessionQuestion(environmentId, sessionId, storage);
  if (previous?.id === input.id) {
    if (previous.prompt !== prompt || JSON.stringify(previous.options) !== JSON.stringify(options) ||
        previous.allowCustom !== (input.allowCustom !== false))
      throw new Error("Question request ID conflicts with an existing question.");
    return previous;
  }
  if (previous?.status === "pending") throw new Error("This session already has an unanswered question.");
  const question: ChatGPTSessionQuestion = {
    id: input.id, prompt, options, allowCustom: input.allowCustom !== false, askedAt: now,
    status: "pending",
  };
  writeQuestion(environmentId, sessionId, question, storage);
  return question;
}

/** Call only after the answer has been durably queued to the exact session.
 * The queue's own message ID is retained so uncertain sends can be reconciled. */
export function answerChatGPTSessionQuestion(
  environmentId: string, sessionId: string, questionId: string,
  answer: string, answerMessageId: string, storage: Storage = window.localStorage,
  now = Date.now(),
): ChatGPTSessionQuestion {
  const previous = readChatGPTSessionQuestion(environmentId, sessionId, storage);
  if (!previous || previous.id !== questionId) throw new Error("Question no longer pending.");
  if (previous.status === "answered") {
    if (previous.answer === answer && previous.answerMessageId === answerMessageId) return previous;
    throw new Error("Question has already been answered.");
  }
  const normalized = answer.trim();
  if (!normalized || normalized.length > 4000 ||
      (!previous.allowCustom && !previous.options.includes(normalized)))
    throw new Error("Choose one of the provided options or enter a permitted custom answer.");
  const resolved: ChatGPTSessionQuestion = { ...previous, status: "answered",
    answer: normalized, answerMessageId, answeredAt: now };
  writeQuestion(environmentId, sessionId, resolved, storage);
  return resolved;
}

export function useChatGPTSessionQuestion(environmentId: string, sessionId: string) {
  const key = keyFor(environmentId, sessionId);
  const raw = useSyncExternalStore(
    (notify) => {
      const local = (event: Event) => { if ((event as CustomEvent<string>).detail === key) notify(); };
      const crossWindow = (event: StorageEvent) => { if (event.key === key) notify(); };
      window.addEventListener(EVENT, local);
      window.addEventListener("storage", crossWindow);
      return () => { window.removeEventListener(EVENT, local); window.removeEventListener("storage", crossWindow); };
    },
    () => { try { return readRaw(key, window.localStorage); } catch { return null; } },
    () => null,
  );
  return useMemo(() => parse(raw), [raw]);
}
