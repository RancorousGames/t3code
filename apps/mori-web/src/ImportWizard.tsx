import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Icon } from "./Icons.tsx";
import { DocMark, GoogleMark, SheetMark } from "./Icons.tsx";
import { ACCEPTED_EXTENSIONS, fetchPublicSheet, kindOf, readFile, type SourceKind, type StagedTable } from "./importers.ts";
import { guessMapping, planImport, processedPreview, signatureOf, type Mapping } from "./importPlan.ts";
import type { MoriProject } from "./model.ts";
import { GoogleConnect } from "./GoogleConnect.tsx";
import { planSheetLinks, type GoogleStagedTable } from "./google-sync.ts";
import { readTemplates, useTemplates, type CharacterTemplate, type ContextTemplate, type GlossaryTemplate } from "./templates.ts";

// Three steps, as in the original import: stage sources, map their columns, then name and create.
// Sources are grouped by their header row. Each group has its own mapping, so one mapping can't
// silently apply to layouts it doesn't fit.

interface StagedSource extends GoogleStagedTable {
  id: number;
  signature: string;
}

interface Group {
  signature: string;
  letter: string;
  headers: string[];
  files: StagedSource[];
}

const KIND_LABEL: Record<SourceKind, string> = {
  json: "JSON", csv: "CSV", txt: "TXT", po: "PO", js: "JS", xlsx: "XLSX", docx: "DOCX", sheet: "SHEETS",
};

const SKIPPED_TYPES = `Only ${ACCEPTED_EXTENSIONS.map(ext => ext.toUpperCase()).join(", ")} files can be imported.`;

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;

/** Walks dropped folders. Entries are read synchronously by the caller before this runs. */
async function collectEntry(entry: FileSystemEntry, prefix: string): Promise<{ file: File; path: string }[]> {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: `${prefix}${entry.name}` }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const nested = await Promise.all(children.map(child => collectEntry(child, `${prefix}${entry.name}/`)));
  return nested.flat();
}

const emptyPlan = { rows: [], characters: [], issues: [], warnings: [], sourceFiles: [], stats: { lines: 0, existing: 0, duplicateLines: 0, speakers: 0, sheets: 0 } };

export function ImportWizard({ initialStep, onClose, onCreate }: {
  initialStep: 1 | 2 | 3;
  onClose: () => void;
  onCreate: (project: MoriProject) => Promise<void>;
}) {
  const templates = useTemplates();
  const [step, setStep] = useState<1 | 2 | 3>(initialStep);
  const [sources, setSources] = useState<StagedSource[]>([]);
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [modes, setModes] = useState<Record<string, "processed" | "raw">>({});
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sheetUrl, setSheetUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [name, setName] = useState("");
  const [contextId, setContextId] = useState("");
  const [glossaryId, setGlossaryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const nextId = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Folder picking is a non-standard attribute, so it's set on the element rather than in JSX.
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const groups = useMemo<Group[]>(() => {
    const bySignature = new Map<string, StagedSource[]>();
    for (const source of sources) bySignature.set(source.signature, [...(bySignature.get(source.signature) ?? []), source]);
    return [...bySignature].map(([signature, files], index) => ({
      signature,
      letter: String.fromCharCode(65 + index),
      headers: files[0]?.headers ?? [],
      files,
    }));
  }, [sources]);

  const mappingFor = (headers: string[]): Mapping => mappings[signatureOf(headers)] ?? guessMapping(headers);
  const setMapping = (group: Group, patch: Partial<Mapping>) =>
    setMappings(current => ({ ...current, [group.signature]: { ...mappingFor(group.headers), ...patch } }));
  const mapsValid = groups.every(group => {
    const mapping = mappingFor(group.headers);
    return !!mapping.id && !!mapping.src;
  });

  const contextTemplates = templates.filter((t): t is ContextTemplate => t.kind === "context");
  const glossaryTemplates = templates.filter((t): t is GlossaryTemplate => t.kind === "glossary");

  const plan = useMemo(() => {
    if (!sources.length) return emptyPlan;
    return planImport({
      sources,
      mappingFor: headers => mappings[signatureOf(headers)] ?? guessMapping(headers),
      characterTemplates: templates.filter((t): t is CharacterTemplate => t.kind === "character"),
    });
  }, [sources, mappings, templates]);

  // Suggest a name the first time the Create step opens. A name the user typed is never replaced.
  useEffect(() => {
    if (step === 3 && !name.trim()) {
      const first = sources[0]?.name.replace(/\.[^.]+$/, "") ?? "";
      setName(first ? `${first} project` : "New project");
    }
  }, [step, name, sources]);

  const stage = async (items: { file: File; path: string }[]) => {
    setBusy(true);
    const existing = new Set(sources.map(source => source.path));
    const next: StagedSource[] = [];
    const messages: string[] = [];
    let skipped = 0;
    for (const { file, path } of items) {
      if (!kindOf(file.name)) {
        skipped++;
        continue;
      }
      if (existing.has(path)) continue;
      try {
        for (const table of await readFile(file, path)) {
          next.push({ ...table, id: nextId.current++, signature: signatureOf(table.headers) });
        }
      } catch (cause) {
        messages.push(cause instanceof Error ? cause.message : `${file.name} couldn’t be read.`);
      }
    }
    if (skipped) messages.push(`${skipped} file${skipped === 1 ? " was" : "s were"} skipped. ${SKIPPED_TYPES}`);
    if (next.length) setSources(current => [...current, ...next]);
    if (messages.length) setProblems(current => [...current, ...messages]);
    setBusy(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    // Entries must be read before the first await, or the browser drops them.
    const entries = [...event.dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
    if (entries.length) {
      void Promise.all(entries.map(entry => collectEntry(entry, ""))).then(groups => stage(groups.flat()));
    } else {
      void stage([...event.dataTransfer.files].map(file => ({ file, path: file.name })));
    }
  };

  const addSheet = async () => {
    const url = sheetUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      const table = await fetchPublicSheet(url);
      setSources(current => [...current, { ...table, id: nextId.current++, signature: signatureOf(table.headers) }]);
      setSheetUrl("");
    } catch (cause) {
      setProblems(current => [...current, cause instanceof Error ? cause.message : "That sheet couldn’t be read."]);
    } finally {
      setBusy(false);
    }
  };

  const stageGoogleTables = (tables: GoogleStagedTable[]) => {
    setSources(current => [
      ...current, ...tables.map(table => ({ ...table, id: nextId.current++, signature: signatureOf(table.headers) })),
    ]);
    setSheetUrl("");
  };
  const remove = (id: number) => {
    setSources(current => current.filter(source => source.id !== id));
    if (previewId === id) setPreviewId(null);
  };

  const create = async () => {
    const context = contextTemplates.find(t => t.id === contextId);
    const glossary = glossaryTemplates.find(t => t.id === glossaryId);
    const project: MoriProject = {
      id: crypto.randomUUID(),
      name: name.trim(),
      sourceFiles: plan.sourceFiles,
      characters: plan.characters,
      glossary: glossary ? glossary.terms.map(term => ({ id: crypto.randomUUID(), en: term.en, jp: term.jp, explanation: term.explanation })) : [],
      context: { global: context?.global ?? "", project: context?.project ?? "" },
      rows: plan.rows,
      lastModified: new Date().toISOString(),
      ...(sources.some(source => source.google) ? { googleSync: planSheetLinks(sources, mappingFor) } : {}),
    };
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(project);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "The project couldn’t be saved.");
      setCreating(false);
    }
  };

  const canStart = !creating && (sources.length === 0 || !plan.issues.length) && !!name.trim();

  const stepButton = (target: 1 | 2 | 3, label: string, index: number) => {
    const reachable = target === 1 || (target === 2 && sources.length > 0) || (target === 3 && sources.length > 0 && mapsValid);
    return (
      <Fragment key={target}>
        {index > 0 && <span className="step-sep" />}
        <button
          type="button"
          className={`step ${step === target ? "on" : step > target ? "done" : ""}`}
          disabled={!reachable}
          onClick={() => setStep(target)}
        >
          <span className="num">{step > target ? <Icon name="check" size="xs" /> : target}</span>
          {label}
        </button>
      </Fragment>
    );
  };

  return (
    <>
      <div className="m-head">
        <Icon name="plus" />
        <h2>New project</h2>
        <div className="steps">
          {stepButton(1, "Sources", 0)}
          {stepButton(2, "Map fields", 1)}
          {stepButton(3, "Create", 2)}
        </div>
        <span className="grow" />
        <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" size="sm" /></button>
      </div>

      <div className="m-body">
        {problems.length > 0 && (
          <div className="imp-err" role="alert">
            <Icon name="alert" size="sm" />
            <span>{problems.join(" ")}</span>
            <button type="button" className="ib" aria-label="Dismiss" onClick={() => setProblems([])}><Icon name="x" size="xs" /></button>
          </div>
        )}

        {step === 1 && (
          <>
            <div className="imp-top">
              <div
                className={`drop${dragOver ? " over" : ""}`}
                onDragOver={event => { event.preventDefault(); setDragOver(true); }}
                onDragLeave={event => { if (event.currentTarget === event.target) setDragOver(false); }}
                onDrop={onDrop}
              >
                <div className="drop-ic"><Icon name="upload" /></div>
                <div className="drop-t">Drop files or folders here</div>
                <div className="drop-s">Folders are scanned recursively. Your original files are never changed.</div>
                <div className="drop-btns">
                  <button type="button" className="btn outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                    <Icon name="file" size="sm" />Choose files…
                  </button>
                  <button type="button" className="btn outline" disabled={busy} onClick={() => folderInput.current?.click()}>
                    <Icon name="folder" size="sm" />Choose folder…
                  </button>
                </div>
                <div className="fmts">
                  {ACCEPTED_EXTENSIONS.map(ext => <span key={ext}>{ext.toUpperCase()}</span>)}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept={ACCEPTED_EXTENSIONS.map(ext => `.${ext}`).join(",")}
                  onChange={event => {
                    const picked = [...(event.target.files ?? [])];
                    event.target.value = "";
                    void stage(picked.map(file => ({ file, path: file.name })));
                  }}
                />
                <input
                  ref={folderInput}
                  type="file"
                  multiple
                  hidden
                  onChange={event => {
                    const picked = [...(event.target.files ?? [])];
                    event.target.value = "";
                    void stage(picked.map(file => ({ file, path: file.webkitRelativePath || file.name })));
                  }}
                />
              </div>

              <div className="gcard">
                <div className="gc-head">
                  <span className="glogo"><GoogleMark /></span>
                  <div className="gc-t"><b>Google Workspace</b><span>Docs and Sheets</span></div>
                </div>
                <GoogleConnect onImport={stageGoogleTables} />
                <div className="or">or a public link</div>
                <div className="field sm">
                  <Icon name="link" size="sm" />
                  <input
                    placeholder="Paste a public Google Sheets URL"
                    aria-label="Public Google Sheets URL"
                    value={sheetUrl}
                    onChange={event => setSheetUrl(event.target.value)}
                    onKeyDown={event => { if (event.key === "Enter") void addSheet(); }}
                  />
                  <button type="button" className="btn xs" disabled={busy || !sheetUrl.trim()} onClick={() => void addSheet()}>Add</button>
                </div>
                <p className="fine">Public links are imported read-only. Signed-in Drive imports create a separate Monku copy and keep sheet-to-row mappings for optional manual sync.</p>
              </div>
            </div>

            <div className="staged">
              <div className="staged-h">
                <b>Staged</b>
                <span>
                  {sources.length
                    ? `${sources.length} source${sources.length === 1 ? "" : "s"} · ${plan.stats.lines || sources.reduce((n, s) => n + s.rows.length, 0)} lines · ${groups.length} layout${groups.length === 1 ? "" : "s"}`
                    : "Nothing staged yet"}
                </span>
              </div>
              {groups.map(group => (
                <div key={group.signature} className="schema">
                  <div className="sch-h">
                    <b>Layout {group.letter}</b>
                    <span>{group.files.length} source{group.files.length === 1 ? "" : "s"} · {group.files.reduce((n, s) => n + s.rows.length, 0)} lines</span>
                    <span className="grow" />
                    <span className="fchips">{group.headers.map(header => <span key={header} className="fchip">{header}</span>)}</span>
                  </div>
                  {group.files.map(source => (
                    <Fragment key={source.id}>
                      <div className="src">
                        {source.kind === "sheet" ? <SheetMark /> : source.kind === "docx" ? <DocMark /> : <Icon name="file" size="sm" />}
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span className="p">{source.path.includes("/") ? `${source.path.slice(0, source.path.lastIndexOf("/") + 1)}` : ""}</span>
                          {source.name}
                        </span>
                        <span className="r tabnum">{source.rows.length} rows</span>
                        <span className="kind">{KIND_LABEL[source.kind]}</span>
                        <span className="acts">
                          <button type="button" className="ib" aria-label="Preview" title="Preview raw content" onClick={() => setPreviewId(previewId === source.id ? null : source.id)}>
                            <Icon name="eye" size="sm" />
                          </button>
                          <button type="button" className="ib" aria-label="Remove" title="Remove from this import" onClick={() => remove(source.id)}>
                            <Icon name="x" size="sm" />
                          </button>
                        </span>
                      </div>
                      {previewId === source.id && (
                        <div className="pv"><RawTable headers={source.headers} rows={source.rows} /></div>
                      )}
                    </Fragment>
                  ))}
                </div>
              ))}
              {!sources.length && (
                <p className="muted" style={{ padding: 20, textAlign: "center", border: "1px dashed var(--line-2)", borderRadius: 10 }}>
                  Nothing staged yet. Add files above, or start an empty project.
                </p>
              )}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            {groups.map(group => {
              const mapping = mappingFor(group.headers);
              const mode = modes[group.signature] ?? "processed";
              const field = (key: keyof Mapping, label: string, required: boolean) => {
                const value = mapping[key];
                return (
                  <label className="mf">
                    <span>{label}{required && <i> *</i>}</span>
                    <select
                      className={`sel${required && !value ? " err" : ""}`}
                      value={value}
                      onChange={event => setMapping(group, { [key]: event.target.value } as Partial<Mapping>)}
                    >
                      <option value="">{required ? "Choose a column…" : "— none"}</option>
                      {group.headers.map(header => <option key={header} value={header}>{header}</option>)}
                    </select>
                  </label>
                );
              };
              const missing = [!mapping.id && "Text ID", !mapping.src && "Source text"].filter(Boolean);
              return (
                <div key={group.signature} className="map-card">
                  <div className="map-h">
                    <b>Layout {group.letter}</b>
                    <span>{group.files.map(s => s.name).join(", ")}</span>
                    <div className="seg">
                      {(["processed", "raw"] as const).map(option => (
                        <button
                          key={option}
                          type="button"
                          className={mode === option ? "on" : ""}
                          onClick={() => setModes(current => ({ ...current, [group.signature]: option }))}
                        >
                          {option === "processed" ? "As Mori sees it" : "Raw"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="map-fields">
                    {field("id", "Text ID", true)}
                    {field("src", "Source text (EN)", true)}
                    {field("tr", "Existing translation", false)}
                    {field("spk", "Speaker", false)}
                    {field("note", "Notes", false)}
                  </div>
                  {missing.length > 0 ? (
                    <p className="map-hint warn"><Icon name="alert" size="xs" />Choose {missing.join(" and ")} to continue.</p>
                  ) : !mapping.spk ? (
                    <p className="map-hint"><Icon name="users" size="xs" />No speaker column, so lines go to Narrator. You can reassign them later.</p>
                  ) : null}
                  {group.files[0] && (mode === "raw"
                    ? <RawTable headers={group.headers} rows={group.files[0].rows} />
                    : <ProcessedTable source={group.files[0]} mapping={mapping} />)}
                </div>
              );
            })}
            <div className="ai-row">
              <Icon name="sparkle" size="sm" />
              <span>AI can suggest these mappings once an AI provider is connected in Settings.</span>
              <span className="grow" />
              <button type="button" className="btn outline sm" disabled><Icon name="sparkle" size="sm" />Suggest mapping</button>
            </div>
          </>
        )}

        {step === 3 && (
          <div className="create">
            <div>
              <label className="mf">
                <span>Project name</span>
                <input className="inp lg" value={name} onChange={event => setName(event.target.value)} />
              </label>
              <div className="langs">
                <label className="mf"><span>From</span><input className="inp" value="English" readOnly /></label>
                <Icon name="arrow" size="sm" />
                <label className="mf"><span>To</span><input className="inp" value="Japanese" readOnly /></label>
              </div>
              <div className="tplb">
                <div className="tplb-h"><Icon name="layers" size="sm" />Start from templates <span>optional. You can edit everything afterwards.</span></div>
                <div className="tpr">
                  <label><Icon name="scroll" size="sm" />Context</label>
                  <select className="sel" value={contextId} onChange={event => setContextId(event.target.value)}>
                    <option value="">— Empty</option>
                    {contextTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="tpr">
                  <label><Icon name="users" size="sm" />Characters</label>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Speakers become characters. A name that matches a saved character template fills in its voice notes.
                  </span>
                </div>
                <div className="tpr">
                  <label><Icon name="book" size="sm" />Glossary</label>
                  <select className="sel" value={glossaryId} onChange={event => setGlossaryId(event.target.value)}>
                    <option value="">— Empty</option>
                    {glossaryTemplates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.terms.length})</option>)}
                  </select>
                </div>
              </div>
              {!readTemplates().length && (
                <p className="fine" style={{ marginTop: 12 }}>Save templates from the Templates menu, the Glossary screen or a speaker card.</p>
              )}
            </div>

            <div className="summary">
              <h3>What gets created</h3>
              {sources.length === 0 ? (
                <p style={{ fontSize: 12.5, color: "var(--text-2)" }}>An empty project. Add sources later from Files.</p>
              ) : (
                <>
                  <div className="sr"><b>{plan.stats.lines}</b><p>lines from {sources.length} source{sources.length === 1 ? "" : "s"}</p></div>
                  <div className="sr"><b>{plan.stats.existing}</b><p>existing translations<small>Kept as dev drafts, never as your final text.</small></p></div>
                  <div className="sr"><b>{plan.stats.speakers}</b><p>speakers → characters<small>Lines without a speaker go to Narrator.</small></p></div>
                  <div className="sr"><b>{plan.stats.duplicateLines}</b><p>lines with duplicate English<small>Shown side by side so you can reuse a translation.</small></p></div>
                  {plan.stats.sheets > 0 && (
                    <div className="sr"><b>{plan.stats.sheets}</b><p>Google worksheet{plan.stats.sheets === 1 ? "" : "s"}<small>Public links are read-only; signed-in Drive imports can sync curated text to their Monku-created copies.</small></p></div>
                  )}
                </>
              )}
              {plan.warnings.length > 0 && (
                <p className="fine" style={{ marginTop: 10 }}>{plan.warnings.length} line{plan.warnings.length === 1 ? "" : "s"} skipped: {plan.warnings.slice(0, 2).join(" ")}</p>
              )}
              {sources.length > 0 && plan.issues.length > 0 && (
                <div className="imp-err" role="alert">
                  <Icon name="alert" size="sm" />
                  <span>
                    Fix these before starting: {plan.issues.slice(0, 4).join(" ")}
                    {plan.issues.length > 4 && ` (and ${plan.issues.length - 4} more)`}
                  </span>
                </div>
              )}
              {createError && <div className="imp-err" role="alert"><Icon name="alert" size="sm" /><span>{createError}</span></div>}
              <p className="fine" style={{ marginTop: 10 }}>Saved in the Monku project library (native on Windows, browser storage in the web preview).</p>
            </div>
          </div>
        )}
      </div>

      <div className="m-foot">
        <span className="muted" style={{ fontSize: 12 }}>Step {step} of 3</span>
        {step === 1 && (
          <button type="button" className="btn sm" onClick={() => setStep(3)}>Start empty project</button>
        )}
        <span className="grow" />
        {step > 1 ? (
          <button type="button" className="btn" onClick={() => setStep(step === 3 ? 2 : 1)}>Back</button>
        ) : (
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        )}
        {step === 1 && (
          <button type="button" className="btn primary" disabled={!sources.length || busy} onClick={() => setStep(2)}>
            Map fields <Icon name="arrow" size="sm" />
          </button>
        )}
        {step === 2 && (
          <button type="button" className="btn primary" disabled={!mapsValid} onClick={() => setStep(3)}>
            Continue <Icon name="arrow" size="sm" />
          </button>
        )}
        {step === 3 && (
          <button type="button" className="btn primary" disabled={!canStart} onClick={() => void create()}>
            <Icon name="check" size="sm" />{creating ? "Creating…" : "Start project"}
          </button>
        )}
      </div>
    </>
  );
}

function RawTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <table className="tbl">
      <thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
      <tbody>
        {rows.slice(0, 6).map((cells, rowIndex) => (
          <tr key={rowIndex}>{headers.map((_, index) => <td key={index}>{cells[index] ?? ""}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function ProcessedTable({ source, mapping }: { source: StagedTable; mapping: Mapping }) {
  return (
    <table className="tbl">
      <thead><tr><th>Text ID</th><th>Speaker</th><th>Source (EN)</th><th>Existing translation</th></tr></thead>
      <tbody>
        {processedPreview(source, mapping).map((line, index) => (
          <tr key={index}>
            <td className="mono">{line.id || <span className="empty">—</span>}</td>
            <td>{line.speaker || <span className="muted">Narrator</span>}</td>
            <td>{line.source}</td>
            <td className="ja">{line.existing || <span className="empty">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
