import type { Mapping } from "./importPlan.ts";
import type { StagedTable } from "./importers.ts";
import type { MoriProject } from "./model.ts";

export interface GoogleSheetSource {
  sourceId: string;
  copyId: string;
  sourceName: string;
  sheetName: string;
  rowNumbers: number[]; // One-based actual sheet row numbers (not filtered array offsets).
  headerRow: number;
}
export type GoogleStagedTable = StagedTable & { google?: GoogleSheetSource };
export interface GoogleSyncCell {
  rowId: string;
  rowNumber: number;
  /** The last known contents of this exact cell in the Monku-created copy. */
  expected: string;
}
export interface GoogleSyncSheet {
  sourceId: string;
  copyId: string;
  sourceName: string;
  sheetName: string;
  translationColumn: string;
  cells: GoogleSyncCell[];
}
export interface GoogleSyncMetadata {
  version: 1;
  sheets: GoogleSyncSheet[];
}
export const spreadsheetColumn = (index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 18278) throw Error("Invalid spreadsheet column.");
  let result = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
};
export const quoteSheetName = (name: string) => {
  if (!name.trim() || name.length > 100 || /[\r\n!]/.test(name)) throw Error("Invalid Google Sheets tab name.");
  return "'" + name.replace(/'/g, "''") + "'";
};
export const a1 = (sheet: GoogleSyncSheet, row: number) => {
  if (!Number.isInteger(row) || row < 1 || row > 1_000_000) throw Error("Invalid row number.");
  return `${quoteSheetName(sheet.sheetName)}!${sheet.translationColumn}${row}`;
};

export function planSheetLinks(sources: GoogleStagedTable[], mappingFor: (headers: string[]) => Mapping): GoogleSyncMetadata {
  return {
    version: 1,
    sheets: sources.flatMap(source => {
      if (!source.google) return [];
      const mapping = mappingFor(source.headers);
      const translationIndex = source.headers.indexOf(mapping.tr);
      const idIndex = source.headers.indexOf(mapping.id);
      if (idIndex < 0 || translationIndex < 0) return [];
      const google = source.google;
      const cells = source.rows.flatMap((row, index) => {
        const rowId = row[idIndex]?.trim();
        const rowNumber = google.rowNumbers[index];
        if (!rowId || !rowNumber) return [];
        return [{ rowId, rowNumber, expected: row[translationIndex] ?? "" }];
      });
      return [{
        sourceId: google.sourceId, copyId: google.copyId, sourceName: google.sourceName,
        sheetName: google.sheetName, translationColumn: spreadsheetColumn(translationIndex),
        cells,
      }];
    }),
  };
}
export function plannedSyncUpdates(project: MoriProject, sheet: GoogleSyncSheet) {
  const byId = new Map(project.rows.map(row => [row.id, row]));
  return sheet.cells.flatMap(cell => {
    const row = byId.get(cell.rowId);
    if (!row || !row.final.trim() || row.final === cell.expected) return [];
    return [{
      rowId: row.id, rowNumber: cell.rowNumber,
      range: a1(sheet, cell.rowNumber),
      expected: cell.expected, next: row.final,
    }];
  });
}
export function updateSyncBaseline(project: MoriProject, copyId: string, committed: { rowId: string; next: string }[]): MoriProject {
  const metadata = project.googleSync as GoogleSyncMetadata | undefined;
  if (!metadata?.sheets || metadata.version !== 1) return project;
  const changes = new Map(committed.map(cell => [cell.rowId, cell.next]));
  return {
    ...project,
    googleSync: {
      version: 1,
      sheets: metadata.sheets.map(sheet => sheet.copyId !== copyId ? sheet : ({
        ...sheet,
        cells: sheet.cells.map(cell => changes.has(cell.rowId) ?
          { ...cell, expected: changes.get(cell.rowId)! } : cell),
      })),
    } satisfies GoogleSyncMetadata,
  };
}
