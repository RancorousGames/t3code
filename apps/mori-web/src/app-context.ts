import { createContext, useContext, type MutableRefObject } from "react";
import type { MoriProject, MoriRow } from "./model.ts";
import type { ColumnPref, MoriPrefs, ResizableColumn } from "./prefs.ts";
import type { ActionId, Bindings } from "./shortcuts.ts";
import type { MoriActions, SaveState } from "./store.ts";
import type { ViewFilters } from "./insights.ts";
import type { LibraryEntry } from "./library.ts";
import type { PopAlign } from "./Overlays.tsx";

export type Screen = "matrix" | "focus" | "characters" | "glossary" | "context" | "project" | "settings" | "chatgpt";

export type PopState = {
  kind: "speaker" | "speakerFilter" | "columns" | "projects" | "templates" | "integrations";
  anchor: HTMLElement;
  /** The line a speaker popover is changing. */
  rowId?: string;
  align?: PopAlign;
  width?: number;
};

export type ModalState =
  | { kind: "shortcuts" }
  | { kind: "palette" }
  | { kind: "import"; step: 1 | 2 | 3 }
  | { kind: "templates" };

export interface AppValue {
  project: MoriProject;
  actions: MoriActions;
  save: SaveState;
  library: LibraryEntry[];
  prefs: MoriPrefs;
  setPrefs: (patch: Partial<MoriPrefs>) => void;
  setColumn: (column: ResizableColumn, patch: Partial<ColumnPref>) => void;
  bindings: Bindings;
  setBindings: (next: Bindings) => void;

  screen: Screen;
  go: (screen: Screen) => void;
  view: ViewFilters;
  setView: (patch: Partial<ViewFilters>) => void;
  /** Lines the Matrix shows, in project order. */
  visible: MoriRow[];
  activeId: string | null;
  activeRow: MoriRow | null;
  select: (id: string, focus?: boolean) => void;
  step: (delta: 1 | -1) => void;
  /** Folded state for file groups ("group:<path>") and inspector sections ("sec:<name>"). */
  folded: Set<string>;
  toggleFold: (key: string) => void;

  pop: PopState | null;
  openPop: (state: PopState) => void;
  closePop: () => void;
  modal: ModalState | null;
  openModal: (state: ModalState) => void;
  closeModal: () => void;

  toast: (message: string) => void;
  adopt: (id: string, text: string, label: string) => void;
  toggleLock: (id: string) => void;
  insertToken: (token: string) => void;
  runAction: (id: ActionId) => void;
  /** Set by the shortcut editor while it waits for a key, so the global handler stays out of the way. */
  capturingRef: MutableRefObject<boolean>;

  openProject: (id: string) => Promise<void>;
  createProject: (project: MoriProject) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Project-wide notice, for example when storage is unavailable. */
  notice: string | null;
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside MoriApp.");
  return value;
}
