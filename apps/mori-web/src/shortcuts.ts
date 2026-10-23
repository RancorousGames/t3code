export type ActionId =
  | "next" | "prev" | "keepNext" | "find" | "palette"
  | "useAI" | "useDev" | "insertTok" | "lock" | "speaker"
  | "inspector" | "shortcuts" | "newProject";

export type ActionGroup = "Moving around" | "Translating" | "Window";

export interface ActionDef {
  id: ActionId;
  label: string;
  group: ActionGroup;
  def: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "next", label: "Next line", group: "Moving around", def: "Alt+ArrowDown" },
  { id: "prev", label: "Previous line", group: "Moving around", def: "Alt+ArrowUp" },
  { id: "keepNext", label: "Keep & jump to next unfinished", group: "Moving around", def: "Ctrl+Enter" },
  { id: "find", label: "Find in lines", group: "Moving around", def: "Ctrl+F" },
  { id: "palette", label: "Search everything", group: "Moving around", def: "Ctrl+K" },
  { id: "useAI", label: "Use AI draft", group: "Translating", def: "Ctrl+Shift+A" },
  { id: "useDev", label: "Use dev draft", group: "Translating", def: "Ctrl+Shift+D" },
  { id: "insertTok", label: "Insert missing placeholder", group: "Translating", def: "Ctrl+Shift+P" },
  { id: "lock", label: "Lock / unlock line", group: "Translating", def: "Ctrl+L" },
  { id: "speaker", label: "Change speaker", group: "Translating", def: "Ctrl+Shift+S" },
  { id: "inspector", label: "Show / hide inspector", group: "Window", def: "Ctrl+I" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "Window", def: "F1" },
  { id: "newProject", label: "New project", group: "Window", def: "Ctrl+N" },
];

export const GROUPS: ActionGroup[] = ["Moving around", "Translating", "Window"];

export type Bindings = Record<ActionId, string>;

export const defaultBindings = (): Bindings =>
  Object.fromEntries(ACTIONS.map(action => [action.id, action.def])) as Bindings;

const STORAGE_KEY = "mori.shortcuts.v1";

export function loadBindings(): Bindings {
  const bindings = defaultBindings();
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    for (const action of ACTIONS) {
      const value = stored[action.id];
      if (typeof value === "string") bindings[action.id] = value;
    }
  } catch {
    // Unreadable shortcut settings fall back to the defaults rather than blocking the app.
  }
  return bindings;
}

export const saveBindings = (bindings: Bindings) => localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));

const NAMES: Record<string, string> = {
  ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc",
};

/** Human label for a stored binding such as "Ctrl+Shift+A" or "Alt+ArrowDown". */
export const keyLabel = (binding: string): string => binding.split("+").map(part => NAMES[part] ?? part).join("+");

type KeyEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** Builds the stored form of a key press, or null for lone modifier keys. */
export function keyString(event: KeyEventLike): string | null {
  const key = event.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  const name = key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(name);
  return parts.join("+");
}

/** Only Ctrl/Alt chords and F-keys can be bound, so a binding never steals a typed letter. */
export const isBindable = (binding: string): boolean => /^(Ctrl|Alt)\+/.test(binding) || /^(Shift\+)?F\d+$/.test(binding);

export const matchAction = (bindings: Bindings, binding: string): ActionId | undefined =>
  ACTIONS.find(action => bindings[action.id] === binding)?.id;

export interface AssignResult {
  bindings: Bindings;
  /** The action that already used the key; it receives the previous binding. */
  swappedWith?: ActionDef;
  error?: string;
}

export const clearBinding = (bindings: Bindings, id: ActionId): Bindings => ({ ...bindings, [id]: "" });

export function assignBinding(bindings: Bindings, id: ActionId, binding: string): AssignResult {
  if (!isBindable(binding)) {
    return { bindings, error: "Use Ctrl or Alt with a key (or an F-key) so it never clashes with typing." };
  }
  const clash = ACTIONS.find(action => action.id !== id && bindings[action.id] === binding);
  const next: Bindings = { ...bindings, [id]: binding };
  if (clash) next[clash.id] = bindings[id];
  return clash ? { bindings: next, swappedWith: clash } : { bindings: next };
}
