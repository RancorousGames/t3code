import { useEffect, useSyncExternalStore } from "react";
import { loadProject } from "./library.ts";
import type { MoriProject } from "./model.ts";

export const MORI_UI_PROJECT_ID = "mori_self_ui_ja";
export type UiLanguage = "en" | "ja";
const LANGUAGE_KEY = "mori.interface-language.v1";
let language: UiLanguage = localStorage.getItem(LANGUAGE_KEY) === "ja" ? "ja" : "en";
let translations = new Map<string, string>();
let version = 0;
let loadedOnce = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;
function changed() { version++; for (const listener of listeners) listener(); }

export function uiLanguage(): UiLanguage { return language; }
export function setUiLanguage(next: UiLanguage) {
  if (language === next) return;
  language = next;
  localStorage.setItem(LANGUAGE_KEY, next);
  document.documentElement.lang = next;
  changed();
}
export function tr(source: string): string {
  return language === "ja" ? translations.get(source) ?? source : source;
}
export function translatedUiCount(): number { return translations.size; }

/** Explicitly re-read the authoritative project library. The current language
 * stays selected; listeners are notified only if curated strings changed. */
export async function reloadUiTranslations(): Promise<number> {
  const stored = await loadProject(MORI_UI_PROJECT_ID);
  if (!stored) throw new Error("Monku no Mori interface translation project was not found.");
  applyProject(stored);
  return translations.size;
}

function applyProject(project: MoriProject) {
  // The Japanese UI is a live preview of this translation project: approved
  // text always wins, with AI drafts shown only where no curated text exists.
  // Previewing suggestions never changes their draft/approval status.
  const next = new Map<string, string>();
  for (const row of project.rows) {
    const japanese = row.final.trim() ? row.final : row.ai;
    if (japanese?.trim()) next.set(row.source, japanese);
  }
  if (next.size === translations.size &&
      [...next].every(([key, value]) => translations.get(key) === value)) return;
  translations = next;
  changed();
}

/** Called from the app root so every screen re-renders when translations
 * change, even when the current translation project is not Mori itself. */
export function useUiLocalization(project: MoriProject | null) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    document.documentElement.lang = language;
    if (loadedOnce) return;
    loadedOnce = true;
    void loadProject(MORI_UI_PROJECT_ID).then(stored => {
      if (stored) applyProject(stored);
    }).catch(() => { loadedOnce = false; });
  }, []);
  useEffect(() => {
    if (project?.id === MORI_UI_PROJECT_ID) applyProject(project);
  }, [project]);
}

export function useUiLanguage() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { language, setLanguage: setUiLanguage, translated: translations.size };
}
