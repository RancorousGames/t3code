import type { CSSProperties } from "react";

// Muted tones that stay readable on the dark-forest background.
const SPEAKER_TONES = ["#7fcdb8", "#d6a97c", "#df9fbe", "#a3b3a9", "#aaa7da", "#e3a5a5", "#c8b07a", "#9fd38a", "#8fb8e0"];

/** A character keeps the same colour in every view, derived from its ID. */
export function characterColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SPEAKER_TONES[hash % SPEAKER_TONES.length] ?? SPEAKER_TONES[0]!;
}

/** Sets one CSS custom property inline, for styles that depend on data (colours, widths). */
export const cssVar = (name: string, value: string): CSSProperties => ({ [name]: value } as CSSProperties);
