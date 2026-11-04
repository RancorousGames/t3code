import type { MoriProject } from "./model.ts";

const LEGACY_DEMOS = new Map([
  ["mori_sample_hollowmere", "Lanterns of Hollowmere (demo)"],
  ["mori_skeleton_demo", "Demo – not a real translation project"],
]);

/** Only remove Mori's own formerly auto-created examples, never user projects. */
export function isLegacyDemo(project: MoriProject): boolean {
  return LEGACY_DEMOS.get(project.id) === project.name;
}

/** Refresh bundled UI keys while keeping local translations, drafts, and review history. */
export function mergeUiCatalog(catalog: MoriProject, saved: MoriProject | null): MoriProject {
  if (!saved) return catalog;
  const savedRows = new Map(saved.rows.map(row => [row.id, row]));
  const activeIds = new Set(catalog.rows.map(row => row.id));
  const rows = catalog.rows.map(row => {
    const prior = savedRows.get(row.id);
    if (!prior || prior.source !== row.source) return row;
    const final = prior.final.trim() || prior.ai?.trim() ? prior.final : row.final;
    return {
      ...row,
      ...prior,
      ...(row.sourceFile !== undefined ? { sourceFile: row.sourceFile } : {}),
      ...(row.note !== undefined ? { note: row.note } : {}),
      final,
      status: final.trim() ? "translated" as const : prior.ai?.trim() ? "draft" as const : "pending" as const,
    };
  });
  // Retired labels with translation work remain accessible; no curated work is discarded.
  rows.push(...saved.rows.filter(row => !activeIds.has(row.id) && (row.final.trim() || row.ai?.trim()))
    .map(row => ({ ...row, sourceFile: row.sourceFile?.startsWith("_retired/") ? row.sourceFile : "_retired/" + (row.sourceFile ?? "unknown") })));
  const sourceFiles = [...new Set(rows.map(row => row.sourceFile).filter((name): name is string => !!name))];
  if (JSON.stringify(rows) === JSON.stringify(saved.rows) &&
      JSON.stringify(sourceFiles) === JSON.stringify(saved.sourceFiles)) return saved;
  return { ...saved, rows, sourceFiles };
}
