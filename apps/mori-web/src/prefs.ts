import { useEffect, useState } from "react";

// Workspace preferences only. Translation data is never stored here.
export type ResizableColumn = "speaker" | "src" | "dev" | "ai" | "tr";

export interface ColumnPref {
  collapsed: boolean;
  /** Pixel width after a drag; null keeps the default proportion. */
  width: number | null;
}

export interface MoriPrefs {
  density: "comfortable" | "compact";
  textSize: "sm" | "md" | "lg";
  jaFont: string;
  inspectorOpen: boolean;
  columns: Record<ResizableColumn, ColumnPref>;
}

export const JA_FONTS = [
  { value: "BIZ UDPGothic", label: "BIZ UDPGothic (most legible)" },
  { value: "Meiryo", label: "Meiryo" },
  { value: "Yu Gothic UI", label: "Yu Gothic UI" },
  { value: "Noto Sans JP", label: "Noto Sans JP" },
  { value: "Yu Mincho", label: "Yu Mincho (serif)" },
];

const TEXT_SCALES = { sm: "0.9", md: "1", lg: "1.12" } as const;

export const DEFAULT_COLUMN_PREFS: MoriPrefs["columns"] = {
  speaker: { collapsed: false, width: null },
  src: { collapsed: false, width: null },
  dev: { collapsed: true, width: null },
  ai: { collapsed: false, width: null },
  tr: { collapsed: false, width: null },
};

const defaults: MoriPrefs = {
  density: "comfortable",
  textSize: "md",
  jaFont: "BIZ UDPGothic",
  inspectorOpen: true,
  // The dev draft column starts collapsed: it is reference material, not the working text.
  columns: DEFAULT_COLUMN_PREFS,
};

const STORAGE_KEY = "mori.prefs.v1";

const load = (): MoriPrefs => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MoriPrefs>;
    return {
      ...defaults,
      ...stored,
      columns: { ...defaults.columns, ...stored.columns },
    };
  } catch {
    return defaults;
  }
};

export function usePrefs() {
  const [prefs, setPrefs] = useState(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    const style = document.documentElement.style;
    style.setProperty("--ja-scale", TEXT_SCALES[prefs.textSize]);
    style.setProperty("--ja", `"${prefs.jaFont}", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif`);
  }, [prefs]);

  const update = (patch: Partial<MoriPrefs>) => setPrefs(current => ({ ...current, ...patch }));
  const setColumn = (column: ResizableColumn, patch: Partial<ColumnPref>) =>
    setPrefs(current => ({ ...current, columns: { ...current.columns, [column]: { ...current.columns[column], ...patch } } }));

  return { prefs, update, setColumn } as const;
}
