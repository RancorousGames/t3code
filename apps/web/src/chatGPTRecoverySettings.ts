import { useSyncExternalStore } from "react";

/** Device-local recovery tuning; defaults preserve the original safe cadence. */
export interface ChatGPTRecoverySettings {
  paused: boolean;
  scanSeconds: number;
  globalSeconds: number;
  perSessionSeconds: number;
  orangeGraceMinutes: number;
  missingComposerSeconds: number;
  targetCount: number;
  ordering: "recent-first" | "managers-first";
}

export const DEFAULT_CHATGPT_RECOVERY_SETTINGS: ChatGPTRecoverySettings = {
  paused: false,
  scanSeconds: 20,
  globalSeconds: 30,
  perSessionSeconds: 120,
  orangeGraceMinutes: 10,
  missingComposerSeconds: 60,
  targetCount: 3,
  ordering: "recent-first",
};
const KEY = "t3code:chatgpt-browser:recovery-preferences:v1";
const EVENT = "chatgpt-recovery-settings-changed";
const ranges = {
  scanSeconds: [10, 20, 30, 60],
  globalSeconds: [10, 20, 30, 60],
  perSessionSeconds: [30, 60, 120, 300],
  orangeGraceMinutes: [2, 5, 10, 20],
  missingComposerSeconds: [30, 60, 120],
  targetCount: [1, 2, 3],
} as const;
let rawCache: string | null | undefined;
let settingsCache: ChatGPTRecoverySettings = DEFAULT_CHATGPT_RECOVERY_SETTINGS;

export function readChatGPTRecoverySettings(): ChatGPTRecoverySettings {
  if (typeof window === "undefined") return DEFAULT_CHATGPT_RECOVERY_SETTINGS;
  const raw = window.localStorage.getItem(KEY);
  if (raw === rawCache) return settingsCache;
  rawCache = raw;
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch { /* Invalid preferences revert to defaults. */ }
  const next = { ...DEFAULT_CHATGPT_RECOVERY_SETTINGS };
  for (const field of Object.keys(ranges) as Array<keyof typeof ranges>) {
    if ((ranges[field] as readonly number[]).includes(input[field] as number)) next[field] = input[field] as number;
  }
  next.paused = typeof input.paused === "boolean" ? input.paused : false;
  next.ordering = input.ordering === "managers-first" ? "managers-first" : "recent-first";
  settingsCache = next;
  return next;
}

export function updateChatGPTRecoverySettings(patch: Partial<ChatGPTRecoverySettings>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readChatGPTRecoverySettings(), ...patch }));
    window.dispatchEvent(new window.Event(EVENT));
  } catch { /* Fail closed to current settings. */ }
}
export function subscribeChatGPTRecoverySettings(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
export const useChatGPTRecoverySettings = () =>
  useSyncExternalStore(subscribeChatGPTRecoverySettings, readChatGPTRecoverySettings, () => DEFAULT_CHATGPT_RECOVERY_SETTINGS);
