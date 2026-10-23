/**
 * Operator-marked costly models, stored on this device only. This is a
 * visibility and confirm-before-launch aid for launches started from T3; it
 * cannot stop agents or backends that create sessions on their own (neither
 * OpenRig nor T3 exposes a model approval or budget hook today).
 */
const COSTLY_KEY = "t3code:openrig-costly-model-patterns:v1";
export const DEFAULT_COSTLY_PATTERNS: readonly string[] = ["gpt-6-astra"];

export function readCostlyPatterns(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage?.getItem(COSTLY_KEY) ?? "null");
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? (parsed as string[])
      : DEFAULT_COSTLY_PATTERNS;
  } catch {
    return DEFAULT_COSTLY_PATTERNS;
  }
}

export function writeCostlyPatterns(patterns: readonly string[]) {
  try {
    window.localStorage?.setItem(COSTLY_KEY, JSON.stringify(patterns));
  } catch {
    /* Session-only preference. */
  }
}

/** Comma/newline separated, trimmed, lowercased, de-duplicated. */
export function parseCostlyPatterns(text: string): string[] {
  return [...new Set(text.split(/[,\n]/u).map((entry) => entry.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

/** Case-insensitive substring match. An unknown model is never reported as cheap or costly. */
export function isCostlyModel(model: string | null, patterns: readonly string[]): boolean {
  if (!model) return false;
  const value = model.toLowerCase();
  return patterns.some((pattern) => pattern && value.includes(pattern.toLowerCase()));
}

/** The stored effort option (`effort`, `reasoningEffort`, ...), if the selection records one. */
export function selectionEffort(options: unknown): string | null {
  if (Array.isArray(options)) {
    for (const option of options) {
      if (typeof option === "object" && option !== null && "id" in option && "value" in option &&
        typeof option.id === "string" && /effort|reasoning/iu.test(option.id))
        return String(option.value);
    }
    return null;
  }
  if (typeof options === "object" && options !== null) {
    for (const [key, value] of Object.entries(options))
      if (/effort|reasoning/iu.test(key) && (typeof value === "string" || typeof value === "number")) return String(value);
  }
  return null;
}
