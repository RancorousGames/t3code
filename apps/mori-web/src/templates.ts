import { useSyncExternalStore } from "react";

// Reusable pieces of a project. Saved templates are copied into a project when used,
// so editing a template later never changes existing translation work.
export interface CharacterTemplate {
  kind: "character";
  id: string;
  name: string;
  role: string;
  tone: string;
  description: string;
}

export interface ContextTemplate {
  kind: "context";
  id: string;
  name: string;
  global: string;
  project: string;
}

export interface GlossaryTemplate {
  kind: "glossary";
  id: string;
  name: string;
  terms: { en: string; jp: string; explanation: string }[];
}

export type MoriTemplate = CharacterTemplate | ContextTemplate | GlossaryTemplate;

/** Starter examples that ship with the app. They are never saved or edited; copy one to make your own. */
export const EXAMPLE_CHARACTERS: CharacterTemplate[] = [
  { kind: "character", id: "example-noble", name: "Noble lady", role: "Example · noble", tone: "Formal, poised", description: "一人称「わたくし」。語尾「〜ですわ」。" },
  { kind: "character", id: "example-elder", name: "Gruff old man", role: "Example · elder", tone: "Rough, rural", description: "一人称「わし」。語尾「〜じゃ」「〜のう」。" },
  { kind: "character", id: "example-child", name: "Cheerful kid", role: "Example · child", tone: "Bright, short", description: "一人称「ぼく」。ひらがな多め、感嘆符多め。" },
];

const STORAGE_KEY = "mori.templates.v1";
const CHANGE_EVENT = "mori-templates-changed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown) => (typeof value === "string" ? value : "");

function parseTemplate(value: unknown): MoriTemplate | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  if (value.kind === "character") {
    return { kind: "character", id: value.id, name: value.name, role: str(value.role), tone: str(value.tone), description: str(value.description) };
  }
  if (value.kind === "context") {
    return { kind: "context", id: value.id, name: value.name, global: str(value.global), project: str(value.project) };
  }
  if (value.kind === "glossary" && Array.isArray(value.terms)) {
    const terms = value.terms.filter(isRecord).map(term => ({ en: str(term.en), jp: str(term.jp), explanation: str(term.explanation) }));
    return { kind: "glossary", id: value.id, name: value.name, terms };
  }
  return null;
}

const readRaw = () => localStorage.getItem(STORAGE_KEY) ?? "[]";

/** Parsed once per stored string so React sees a stable snapshot between changes. */
let cachedRaw = "";
let cachedList: MoriTemplate[] = [];
export function readTemplates(): MoriTemplate[] {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedList;
  try {
    const parsed: unknown = JSON.parse(raw);
    cachedList = Array.isArray(parsed) ? parsed.map(parseTemplate).filter((t): t is MoriTemplate => t !== null) : [];
  } catch {
    cachedList = [];
  }
  cachedRaw = raw;
  return cachedList;
}

export function writeTemplates(list: MoriTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const subscribe = (onChange: () => void) => {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
};

export const useTemplates = (): MoriTemplate[] => useSyncExternalStore(subscribe, readTemplates, readTemplates);

export const newTemplateId = () => crypto.randomUUID();
