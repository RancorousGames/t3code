import { useState, type ReactNode } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { checkRow, extractTokens, glossaryHits, statusOf } from "./insights.ts";
import { Marked } from "./Marked.tsx";
import type { MoriRow } from "./model.ts";
import { keyLabel } from "./shortcuts.ts";
import { newTemplateId, readTemplates, writeTemplates } from "./templates.ts";
import { characterColor, cssVar } from "./theme.ts";

const STATUS_LABEL = { pending: "Untranslated", draft: "Draft only", translated: "Translated" } as const;

const formatWhen = (timestamp: number) =>
  new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function Inspector() {
  const { activeRow } = useApp();
  if (!activeRow) {
    return <aside className="inspector"><div className="mx-empty">Select a line to see its details.</div></aside>;
  }
  // Keyed by line so voice editing and other local state reset when the selection moves.
  return <InspectorBody key={activeRow.id} row={activeRow} />;
}

function Section({ id, title, badge, children }: { id: string; title: string; badge?: ReactNode; children: ReactNode }) {
  const { folded, toggleFold } = useApp();
  const key = `sec:${id}`;
  return (
    <section className={`sec${folded.has(key) ? " closed" : ""}`}>
      <button type="button" className="sec-h" onClick={() => toggleFold(key)}>
        <Icon name="chevron-down" size="xs" className="chev" />
        <span>{title}</span>
        {badge}
      </button>
      <div className="sec-b">{children}</div>
    </section>
  );
}

function InspectorBody({ row }: { row: MoriRow }) {
  const { project, actions, visible, bindings, openPop, adopt, insertToken, toast, step } = useApp();
  const [editingVoice, setEditingVoice] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState("");
  const glossary = project.glossary;
  const character = project.characters.find(c => c.id === row.characterId);
  const status = statusOf(row);
  const warnings = checkRow(row, glossary);
  const terms = glossaryHits(row.source, glossary);
  const index = visible.findIndex(item => item.id === row.id);
  const duplicates = project.rows.filter(other => other.id !== row.id && other.source.trim() === row.source.trim());

  const startVoiceEdit = () => {
    setVoiceDraft(character?.description ?? "");
    setEditingVoice(true);
  };
  const finishVoiceEdit = () => {
    if (character) actions.updateCharacter(character.id, { description: voiceDraft });
    setEditingVoice(false);
    toast("Voice notes saved. Every line by this character uses them.");
  };
  const saveCharacterTemplate = () => {
    if (!character) return;
    writeTemplates([...readTemplates(), {
      kind: "character", id: newTemplateId(), name: character.name,
      role: character.role, tone: character.tone, description: character.description,
    }]);
    toast(`Saved “${character.name}” as a character template. Reuse it in any project.`);
  };

  // Versions, newest first: the curated text, earlier curated texts, then the drafts.
  const versions: { label: string; when: string; text: string; current: boolean; action: string }[] = [];
  if (row.final.trim()) {
    versions.push({ label: "Yours", when: row.isLocked ? "locked" : "current", text: row.final, current: true, action: "" });
  }
  for (const entry of [...(row.history ?? [])].reverse()) {
    if (entry.type === "curated") versions.push({ label: "Yours", when: formatWhen(entry.timestamp), text: entry.text, current: false, action: "Restore" });
  }
  if (row.ai) versions.push({ label: "AI draft", when: "AI", text: row.ai, current: false, action: "Use" });
  if (row.legacy) versions.push({ label: "Dev draft", when: "from import", text: row.legacy, current: false, action: "Use" });

  const warningBadge = row.final.trim()
    ? (warnings.length
      ? <span className="badge warn">{warnings.length} to fix</span>
      : <span className="badge" style={{ color: "var(--moss)" }}>all good</span>)
    : null;

  return (
    <aside className="inspector">
      <div className="ins-head">
        <div className="ih-row">
          <span className="mono">{row.id}</span>
          <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
          {row.isLocked && <span className="pill lock"><Icon name="lock" size="xs" />Locked</span>}
          <span className="grow" />
          <span className="muted tabnum" style={{ fontSize: 11.5 }}>{index + 1} / {visible.length}</span>
          <button type="button" className="ib" title={`Previous line (${keyLabel(bindings.prev)})`} aria-label="Previous line" onClick={() => step(-1)}>
            <Icon name="chevron-up" size="sm" />
          </button>
          <button type="button" className="ib" title={`Next line (${keyLabel(bindings.next)})`} aria-label="Next line" onClick={() => step(1)}>
            <Icon name="chevron-down" size="sm" />
          </button>
        </div>
        <div className="ih-file"><Icon name="file" size="xs" />{row.sourceFile ?? "No source file"}</div>
      </div>

      <Section id="speaker" title="Speaker">
        {character ? (
          <>
            <div className="who">
              <span className="avl lg" style={cssVar("--c", characterColor(character.id))}>{character.name.charAt(0)}</span>
              <div className="who-t">
                <b>{character.name}</b>
                <span>{character.role}</span>
              </div>
              <button
                type="button"
                className="ib"
                title={`Change speaker (${keyLabel(bindings.speaker)})`}
                aria-label="Change speaker"
                onClick={event => openPop({ kind: "speaker", anchor: event.currentTarget, rowId: row.id, width: 290 })}
              >
                <Icon name="more" size="sm" />
              </button>
            </div>
            {editingVoice ? (
              <textarea className="voice-edit" value={voiceDraft} onChange={event => setVoiceDraft(event.target.value)} aria-label="Voice notes" />
            ) : (
              <p className="voice ja">{character.description || "No voice notes yet."}</p>
            )}
            {character.tone && (
              <div className="tags">
                {character.tone.split(/\s*·\s*/).filter(Boolean).map(tag => <span key={tag} className="tag">{tag}</span>)}
              </div>
            )}
            <div className="sec-actions">
              {editingVoice ? (
                <button type="button" className="btn sm outline" onClick={finishVoiceEdit}><Icon name="check" size="sm" />Done</button>
              ) : (
                <button type="button" className="btn sm outline" onClick={startVoiceEdit}>Edit voice</button>
              )}
              <button type="button" className="btn sm" onClick={saveCharacterTemplate}><Icon name="layers" size="sm" />Save as template</button>
            </div>
          </>
        ) : (
          <>
            <div className="who">
              <span className="avl lg empty" />
              <div className="who-t">
                <b style={{ color: "var(--text-3)" }}>No speaker</b>
                <span>Voice notes appear here once assigned.</span>
              </div>
            </div>
            <div className="sec-actions">
              <button
                type="button"
                className="btn sm outline"
                onClick={event => openPop({ kind: "speaker", anchor: event.currentTarget, rowId: row.id, width: 290 })}
              >
                Assign speaker
              </button>
            </div>
          </>
        )}
      </Section>

      <Section id="checks" title="Checks" badge={warningBadge}>
        {!row.final.trim() ? (
          <p className="muted" style={{ fontSize: 12.5 }}>Runs as you type: placeholders, line breaks and glossary terms.</p>
        ) : (
          <>
            {warnings.map((warning, index) => {
              if (warning.kind === "missing-token" && warning.token) {
                return (
                  <div key={index} className="chk warn">
                    <Icon name="alert" size="sm" />
                    <div className="chk-t">
                      <span>Missing placeholder <span className="tok">{warning.token}</span></span>
                      <p>It’s in the source but not in your text.</p>
                    </div>
                    <button
                      type="button"
                      className="btn xs outline"
                      title={`Insert at the cursor (${keyLabel(bindings.insertTok)})`}
                      disabled={row.isLocked}
                      onClick={() => insertToken(warning.token ?? "")}
                    >
                      Insert
                    </button>
                  </div>
                );
              }
              if (warning.kind === "extra-token" && warning.token) {
                return (
                  <div key={index} className="chk warn">
                    <Icon name="alert" size="sm" />
                    <div className="chk-t">
                      <span>Extra placeholder <span className="tok">{warning.token}</span></span>
                      <p>Not in the source. The game may show it raw.</p>
                    </div>
                  </div>
                );
              }
              if (warning.kind === "glossary" && warning.term) {
                return (
                  <div key={index} className="chk warn">
                    <Icon name="alert" size="sm" />
                    <div className="chk-t">
                      <span>“{warning.term.en}” should be <span className="gl-ja">{warning.term.jp}</span></span>
                      <p>Glossary term isn’t in your text.</p>
                    </div>
                  </div>
                );
              }
              return (
                <div key={index} className="chk warn">
                  <Icon name="alert" size="sm" />
                  <div className="chk-t"><span>{warning.message}</span></div>
                </div>
              );
            })}
            {extractTokens(row.source).length > 0 && !warnings.some(w => w.kind === "missing-token" || w.kind === "extra-token") && (
              <div className="chk ok"><Icon name="check" size="sm" /><div className="chk-t">Placeholders match</div></div>
            )}
            {!warnings.some(w => w.kind === "linebreaks") && (
              <div className="chk ok"><Icon name="check" size="sm" /><div className="chk-t">Line breaks match</div></div>
            )}
            {terms.length > 0 && !warnings.some(w => w.kind === "glossary") && (
              <div className="chk ok"><Icon name="check" size="sm" /><div className="chk-t">Glossary terms used</div></div>
            )}
          </>
        )}
      </Section>

      <Section id="gloss" title="Glossary in this line" badge={terms.length ? <span className="badge">{terms.length}</span> : null}>
        {terms.length ? (
          terms.map(term => {
            const used = row.final.includes(term.jp.trim());
            return (
              <div key={term.id}>
                <div className="gl">
                  <span>{term.en}</span>
                  <Icon name="arrow" size="xs" />
                  <span className="gl-ja">{term.jp}</span>
                  {row.final.trim() && <span className={`gl-st ${used ? "ok" : "warn"}`}>{used ? "used" : "missing"}</span>}
                </div>
                {term.explanation && <p className="gl-note">{term.explanation}</p>}
              </div>
            );
          })
        ) : (
          <p className="muted" style={{ fontSize: 12.5 }}>No glossary terms in this line.</p>
        )}
      </Section>

      {duplicates.length > 0 && (
        <Section id="dupes" title="Same English elsewhere" badge={<span className="badge">{duplicates.length}</span>}>
          {duplicates.map(other => (
            <div key={other.id} className="dupl">
              <div className="dupl-h">
                <span className="mono">{other.id}</span>
                <span>· {other.sourceFile ?? "no file"}</span>
                {other.final.trim() && other.final !== row.final && !row.isLocked && (
                  <button type="button" className="btn xs outline" onClick={() => adopt(row.id, other.final, `Translation from ${other.id}`)}>Use</button>
                )}
                {other.final.trim() && other.final === row.final && (
                  <span style={{ marginLeft: "auto", color: "var(--moss)", fontSize: 11, fontWeight: 600 }}>matches</span>
                )}
              </div>
              <div className="ja">{other.final ? <Marked text={other.final} glossary={glossary} /> : <span className="empty">untranslated</span>}</div>
            </div>
          ))}
        </Section>
      )}

      <Section id="versions" title="Versions" badge={<span className="badge">{versions.length}</span>}>
        {versions.length ? versions.map((version, n) => (
          <div key={n} className={`ver${version.current ? " current" : ""}`} style={cssVar("--k", version.label === "AI draft" ? "var(--mist)" : version.label === "Dev draft" ? "var(--bark)" : "var(--moss)")}>
            <div className="ver-h">
              <b>{version.label}</b>
              <span>· {version.when}</span>
              {!version.current && !row.isLocked && (
                <button
                  type="button"
                  className="btn xs outline"
                  onClick={() => adopt(row.id, version.text, version.label === "Yours" ? "Earlier version" : version.label)}
                >
                  {version.action}
                </button>
              )}
            </div>
            <div className="ja"><Marked text={version.text} glossary={glossary} /></div>
          </div>
        )) : (
          <p className="muted" style={{ fontSize: 12.5 }}>No versions yet.</p>
        )}
      </Section>

      <Section id="note" title="Line note">
        <textarea
          className="note-in"
          placeholder="A note for yourself or the dev team…"
          aria-label="Line note"
          value={row.note ?? ""}
          onChange={event => {
            const note = event.target.value;
            actions.updateRow(row.id, current => ({ ...current, note }));
          }}
        />
      </Section>
    </aside>
  );
}
