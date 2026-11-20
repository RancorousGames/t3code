import { useSyncExternalStore } from "react";
import {
  DEFAULT_CHATGPT_ORANGE_RECOVERY_STRATEGY,
  normalizeChatGPTOrangeRecoveryStrategy,
  type ChatGPTOrangeRecoveryStrategy,
} from "./chatGPTOrangeRecoveryStrategy";

/** Device-local recovery tuning; defaults preserve the original safe cadence. */
export interface ChatGPTRecoverySettings {
  paused: boolean;
  watchdogSeconds: number;
  globalSeconds: number;
  orangeGlobalSeconds: number;
  perSessionSeconds: number;
  orangeGraceMinutes: number;
  orangeStrategy: ChatGPTOrangeRecoveryStrategy;
  retryButtonForRedErrors: boolean;
  missingComposerSeconds: number;
  targetCount: number;
  ordering: "recent-first" | "managers-first";
}

export const DEFAULT_CHATGPT_RECOVERY_SETTINGS: ChatGPTRecoverySettings = {
  paused: false,
  watchdogSeconds: 180,
  globalSeconds: 30,
  orangeGlobalSeconds: 60,
  perSessionSeconds: 120,
  orangeGraceMinutes: 10,
  orangeStrategy: DEFAULT_CHATGPT_ORANGE_RECOVERY_STRATEGY,
  retryButtonForRedErrors: false,
  missingComposerSeconds: 60,
  targetCount: 3,
  ordering: "recent-first",
};
const KEY = "t3code:chatgpt-browser:recovery-preferences:v1";
const EVENT = "chatgpt-recovery-settings-changed";
/** Inclusive safe limits; all timing fields accept custom whole numbers. */
export const CHATGPT_RECOVERY_INTERVAL_BOUNDS = {
  watchdogSeconds: [60, 1800],
  globalSeconds: [5, 3600],
  orangeGlobalSeconds: [5, 3600],
  perSessionSeconds: [5, 7200],
  orangeGraceMinutes: [1, 120],
  missingComposerSeconds: [5, 3600],
} as const;
const ranges = { ...CHATGPT_RECOVERY_INTERVAL_BOUNDS, targetCount: [1, 3] } as const;
export function validRecoverySettingNumber(
  key: keyof typeof ranges,
  value: unknown,
): value is number {
  const [min, max] = ranges[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
const STORAGE_DENIED_RECOVERY_SETTINGS: ChatGPTRecoverySettings = {
  ...DEFAULT_CHATGPT_RECOVERY_SETTINGS,
  paused: true,
};
let rawCache: string | null | undefined;
let settingsCache: ChatGPTRecoverySettings = DEFAULT_CHATGPT_RECOVERY_SETTINGS;

export function readChatGPTRecoverySettings(): ChatGPTRecoverySettings {
  if (typeof window === "undefined") return DEFAULT_CHATGPT_RECOVERY_SETTINGS;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return STORAGE_DENIED_RECOVERY_SETTINGS;
  }
  if (raw === rawCache) return settingsCache;
  rawCache = raw;
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      input = parsed as Record<string, unknown>;
  } catch {
    /* Invalid preferences revert to defaults. */
  }
  // Migrate legacy scan intervals to a slower watchdog; old 5–600 second
  // polling values must not accidentally become a 5-second fallback scan.
  if (input.watchdogSeconds === undefined && typeof input.scanSeconds === "number")
    input.watchdogSeconds = Math.max(60, input.scanSeconds * 6);
  const next = { ...DEFAULT_CHATGPT_RECOVERY_SETTINGS };
  for (const field of Object.keys(ranges) as Array<keyof typeof ranges>) {
    if (validRecoverySettingNumber(field, input[field])) next[field] = input[field] as number;
  }
  next.paused = typeof input.paused === "boolean" ? input.paused : false;
  next.orangeStrategy = normalizeChatGPTOrangeRecoveryStrategy(input.orangeStrategy);
  next.retryButtonForRedErrors = input.retryButtonForRedErrors === true;
  next.ordering = input.ordering === "managers-first" ? "managers-first" : "recent-first";
  settingsCache = next;
  return next;
}

export function updateChatGPTRecoverySettings(patch: Partial<ChatGPTRecoverySettings>): void {
  if (typeof window === "undefined") return;
  try {
    const baseline = readChatGPTRecoverySettings();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        ...baseline,
        ...Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) =>
              !(key in ranges) || validRecoverySettingNumber(key as keyof typeof ranges, value),
          ),
        ),
      }),
    );
    window.dispatchEvent(new window.Event(EVENT));
  } catch {
    /* Fail closed to current settings. */
  }
}
export function subscribeChatGPTRecoverySettings(onChange: () => void): () => void {
  let lastEffective = readChatGPTRecoverySettings();
  const notifyOnlyOnChange = () => {
    const current = readChatGPTRecoverySettings();
    if (current === lastEffective) return;
    lastEffective = current;
    onChange();
  };
  window.addEventListener(EVENT, notifyOnlyOnChange);
  window.addEventListener("storage", notifyOnlyOnChange);
  return () => {
    window.removeEventListener(EVENT, notifyOnlyOnChange);
    window.removeEventListener("storage", notifyOnlyOnChange);
  };
}
export const useChatGPTRecoverySettings = () =>
  useSyncExternalStore(
    subscribeChatGPTRecoverySettings,
    readChatGPTRecoverySettings,
    () => DEFAULT_CHATGPT_RECOVERY_SETTINGS,
  );
