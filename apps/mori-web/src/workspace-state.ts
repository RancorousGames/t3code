import type { Screen } from "./app-context.ts";
import type { ViewFilters } from "./insights.ts";
import type { MoriPrefs } from "./prefs.ts";

export interface WorkspaceState {
  screen: Screen;
  view: ViewFilters;
  activeId: string | null;
  folded: string[];
  matrixSplit: boolean;
  columns: MoriPrefs["columns"];
  scrollTop: number;
  scrollLeft: number;
}

const key = (id: string) => `mori.workspace.v1.${id}`;

export function readWorkspace(id: string): Partial<WorkspaceState> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key(id)) ?? "null");
    return data && typeof data === "object" && !Array.isArray(data)
      ? data as Partial<WorkspaceState> : {};
  } catch { return {}; }
}

export function writeWorkspace(id: string, patch: Partial<WorkspaceState>) {
  const previous = readWorkspace(id);
  localStorage.setItem(key(id), JSON.stringify({ ...previous, ...patch }));
}

export function forgetWorkspace(id: string) {
  localStorage.removeItem(key(id));
}

export function readMatrixScroll(id: string): { top: number; left: number } {
  const state = readWorkspace(id);
  return {
    top: typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop) ? state.scrollTop : 0,
    left: typeof state.scrollLeft === "number" && Number.isFinite(state.scrollLeft) ? state.scrollLeft : 0,
  };
}
