import { useCallback, useEffect, useState } from "react";
import { nativeMori, type GoogleDriveFile } from "./backend.ts";
import { tableFromRows, readFile } from "./importers.ts";
import type { GoogleStagedTable } from "./google-sync.ts";

const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const DOC_MIME = "application/vnd.google-apps.document";
type GoogleStatus = { configured: boolean; connected: boolean; scopes: string[] };
interface Props {
  onImport?: (tables: GoogleStagedTable[]) => void;
}
const explain = (error: unknown) => error instanceof Error ? error.message : "Google Workspace request failed.";

function base64ToFile(base64: string, name: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: "application/octet-stream" });
}

/**
 * Google Drive chooser for the separately installed Mori desktop app.
 * A deliberate button creates a Monku-owned copy before any document is
 * imported. Original Drive IDs are never used as sync-write destinations.
 */
export function GoogleConnect({ onImport }: Props) {
  const api = nativeMori();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [files, setFiles] = useState<GoogleDriveFile[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [filter, setFilter] = useState("");

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    setStatus(await api.googleStatus());
    window.dispatchEvent(new Event("mori:google-state"));
  }, [api]);
  useEffect(() => { void refreshStatus().catch(cause => setProblem(explain(cause))); }, [refreshStatus]);

  const operation = async (task: () => Promise<void>) => {
    setBusy(true); setProblem("");
    try { await task(); } catch (cause) { setProblem(explain(cause)); }
    finally { setBusy(false); }
  };
  const list = async (page?: string) => {
    if (!api) return;
    const result = await api.googleListFiles(page);
    setFiles(current => page ? [...current, ...result.files] : result.files);
    setNextPage(result.nextPageToken);
  };
  const doImport = async (source: GoogleDriveFile) => {
    if (!api || !onImport) return;
    const isSheet = source.mimeType === SHEET_MIME;
    if (!isSheet && source.mimeType !== DOC_MIME) throw Error("Only Google Docs and Sheets are supported.");
    // Copy must be explicitly authorized and visibly distinct from the source.
    if (!window.confirm(`Make a new editable Google Drive copy of “${source.name}” for Monku? The original will remain untouched. The copy will be in the signed-in Google account's Drive.`)) return;
    const copy = await api.googleCopy(source.id, `${source.name} [Monku Copy]`);
    if (isSheet) {
      const info = await api.googleSheetInfo(copy.id);
      const tables: GoogleStagedTable[] = [];
      for (const sheet of info.sheets) {
        // Explicit limit, never silently drop text or pretend all rows were imported.
        if (sheet.rowCount > 10_000) throw Error(`${sheet.title} has ${sheet.rowCount} rows; this importer supports up to 10,000 per tab. Copy ${copy.name} was created but not imported.`);
        const safeTitle = "'" + sheet.title.replace(/'/g, "''") + "'";
        const range = `${safeTitle}!A1:AZ${Math.max(2, sheet.rowCount)}`;
        const data = await api.googleReadValues(copy.id, range);
        const indexed = data.values.map((row, index) => ({ cells: row.map(String), rowNumber: index + 1 }))
          .filter(x => x.cells.some(cell => cell.trim()));
        if (indexed.length < 2) continue;
        const table = tableFromRows(indexed.map(x => x.cells));
        if (!table.headers.length || !table.rows.length) continue;
        tables.push({
          ...table,
          name: `${source.name} · ${sheet.title}`,
          path: `Google Drive/${source.name}/${sheet.title}`,
          kind: "sheet",
          google: {
            sourceId: source.id, copyId: copy.id, sourceName: source.name, sheetName: sheet.title,
            headerRow: indexed[0]!.rowNumber,
            rowNumbers: indexed.slice(1).map(x => x.rowNumber),
          },
        });
      }
      if (!tables.length) throw Error("The copied spreadsheet has no extractable translation tables.");
      onImport(tables);
    } else {
      const exported = await api.googleExport(copy.id, "doc");
      const downloaded = base64ToFile(exported.data, source.name + ".docx");
      const tables = await readFile(downloaded, `Google Drive/${source.name}`);
      // Docs are imported safely but have no editable row/cell mapping yet.
      onImport(tables);
    }
  };

  if (!api) return <div className="muted" style={{ fontSize: 12 }}>Google authentication is available in the installed Monku Windows app.</div>;
  return (
    <div className="mori-google-connect">
      <div className="set-row" style={{ gap: 8, alignItems: "center" }}>
        <div><b>Google Workspace</b><span>{status?.connected ? "Connected to this computer's Monku account" : "Use your own Google account. Local translation files stay on this PC."}</span></div>
        <span className="grow" />
        {!status?.configured
          ? <button className="btn outline sm" disabled={busy} onClick={() => void operation(async () => { await api.googleConfigure(); await refreshStatus(); })}>Choose Google OAuth client…</button>
          : status.connected
            ? <button className="btn outline sm" disabled={busy} onClick={() => void operation(async () => { await api.googleLogout(); setFiles([]); await refreshStatus(); })}>Sign out</button>
            : <button className="btn primary sm" disabled={busy} onClick={() => void operation(async () => { await api.googleLogin(); await refreshStatus(); await list(); })}>Sign in with Google</button>}
      </div>
      {problem && <p className="imp-err" role="alert">{problem}</p>}
      {status?.configured && !status.connected && <p className="muted" style={{ fontSize: 12 }}>Sign-in opens your default browser. If Google restricts this app to test users, the Google Cloud OAuth configuration must allow this account.</p>}
      {status?.connected && <>
        <div className="mori-google-controls">
          <button className="btn outline sm" type="button" disabled={busy} onClick={() => void operation(() => list())}>Browse Drive files</button>
          <input aria-label="Find a Drive file" placeholder="Filter files by name…" value={filter} onChange={event => setFilter(event.target.value)} />
        </div>
        <div className="mori-google-files">
          {files.filter(file => file.name.toLowerCase().includes(filter.toLowerCase())).map(file => (
            <div className="set-row" key={file.id}>
              <div><b>{file.name}</b><span>{file.mimeType === SHEET_MIME ? "Google Sheets" : "Google Docs"} · {file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : "Drive file"}</span></div>
              <span className="grow" />
              {onImport ? <button type="button" className="btn outline sm" disabled={busy} onClick={() => void operation(() => doImport(file))}>Copy & import</button> : <span className="muted" style={{ fontSize: 11 }}>Import from New project</span>}
            </div>
          ))}
        </div>
        {nextPage && <button className="btn outline sm" disabled={busy} onClick={() => void operation(() => list(nextPage))}>Load more…</button>}
      </>}
      {busy && <p className="muted" role="status" style={{ fontSize: 12 }}>Working with Google Workspace…</p>}
      <p className="muted" style={{ fontSize: 11 }}>Monku writes only to copies it creates. Source documents remain unchanged. The translator must review changes before syncing.</p>
    </div>
  );
}
