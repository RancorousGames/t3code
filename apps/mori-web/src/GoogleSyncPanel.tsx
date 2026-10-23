import { useMemo, useState } from "react";
import { useApp } from "./app-context.ts";
import { nativeMori } from "./backend.ts";
import { plannedSyncUpdates, updateSyncBaseline, type GoogleSyncMetadata } from "./google-sync.ts";

export function GoogleSyncPanel() {
  const { project, actions, save } = useApp();
  const api = nativeMori();
  const metadata = project.googleSync as GoogleSyncMetadata | undefined;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const sheets = metadata?.version === 1 && Array.isArray(metadata.sheets) ? metadata.sheets : [];
  const pending = useMemo(() => sheets.map(sheet => ({
    sheet, updates: plannedSyncUpdates(project, sheet),
  })), [sheets, project]);

  async function push() {
    if (!api || busy) return;
    const changes = pending.filter(group => group.updates.length);
    if (!changes.length) { setMessage("No new curated translations are ready to sync."); return; }
    const n = changes.reduce((acc, group) => acc + group.updates.length, 0);
    if (!window.confirm(`Write ${n} curated Japanese translation cells to ${new Set(changes.map(group => group.sheet.copyId)).size} Monku-created Google copy/copies? The original Drive documents will not be edited. Each cell is checked against its last imported/synced value.`)) return;
    setBusy(true); setMessage("Checking current Google copy contents before writing…");
    let saved = 0;
    try {
      for (const group of changes) {
        for (let offset = 0; offset < group.updates.length; offset += 100) {
          const batch = group.updates.slice(offset, offset + 100);
          const receipt = await api.googleSyncChecked(group.sheet.copyId, batch.map(({range, expected, next}) => ({ range, expected, next })));
          if (receipt.conflicts.length) {
            setMessage(`Sync stopped after ${saved} committed cells. ${receipt.conflicts.length} remote cell(s) changed since import or the last sync. Nothing was overwritten at those locations. First conflict: ${receipt.conflicts[0]!.range}. Reimport or reconcile the Google copy before retrying.`);
            return;
          }
          if (receipt.updatedCells !== batch.length) {
            throw Error(`Google reported ${receipt.updatedCells} of ${batch.length} cells updated. No further writes attempted; inspect the copy before retrying.`);
          }
          actions.updateProject(current => updateSyncBaseline(current, group.sheet.copyId, batch));
          saved += batch.length;
          setMessage(`Synchronized ${saved} of ${n} curated cells…`);
        }
      }
      setMessage(`Synchronized ${saved} curated translations to Monku-created Google copies. The original sources were untouched.`);
    } catch (cause) {
      setMessage(`Sync stopped after ${saved} cells: ${cause instanceof Error ? cause.message : "Unexpected error"}. Check the Google copy before retrying.`);
    } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3>Google Sheets synchronization</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        Only writes human-curated translations to a copy created in Google Drive during import.
        Original documents remain untouched. Remote edits trigger a conflict rather than a silent overwrite.
        Google Sheets has no atomic compare-and-set, so simultaneous changes during a write cannot be fully prevented.
      </p>
      {!sheets.length
        ? <p className="muted" style={{ fontSize: 12 }}>No synchronized Google spreadsheet is linked. Import a private Google Sheet with a mapped Japanese column to create one.</p>
        : <>
          {pending.map(({ sheet, updates }, index) => (
            <div className="set-row" key={index}>
              <div><b>{sheet.sourceName} / {sheet.sheetName}</b>
                <span>Monku-owned Google copy · {sheet.cells.length} mapped rows · column {sheet.translationColumn}</span>
              </div>
              <span className="grow" />
              <span className="muted" style={{ fontSize: 12 }}>{updates.length} to sync</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <button type="button" className="btn outline sm"
              disabled={busy || save.kind === "saving" || save.kind === "error" || !api || pending.every(group => !group.updates.length)}
              onClick={() => void push()}>Review & sync curated text to Google copies…</button>
            {save.kind === "saving" && <span className="muted">Finish local save first</span>}
          </div>
        </>
      }
      {message && <p role="status" style={{ marginTop: 12, fontSize: 12 }}>{message}</p>}
    </div>
  );
}
