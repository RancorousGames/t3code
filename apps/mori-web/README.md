# Monku no Mori — translation UI

The Monku web UI. It's a standalone React app with its own dark-forest styling. It doesn't use
the T3 component kit. The design is the approved Matrix mockup
(`D:\SSDProjects\Tools\mori-mockups\matrix.html`, kept outside the repo). `apps/mori-desktop`
packages `dist/` as its renderer.

Product goals and workflows: [MORI_PRODUCT_AND_UI_BRIEF_FOR_CLAUDE.md](MORI_PRODUCT_AND_UI_BRIEF_FOR_CLAUDE.md).
`COMPONENT_CATALOG.md` describes the old T3 kit and no longer applies to this UI.

## What works

- **Matrix**: grouped by source file, with a row per line. Columns: Line, Speaker, Source, Dev draft,
  AI draft, Translation, status. Columns collapse to a strip and resize by dragging; double-click a
  resize handle to reset it. Compact or comfortable rows. Filters: all, to do, draft, translated,
  locked, warnings. Checks shows only lines with problems: missing or extra placeholders, line
  breaks that differ, unused glossary terms, and lines locked without text.
- **Inspector**: speaker and voice notes (editable, savable as a template), checks with an Insert
  action for missing placeholders, glossary terms in the line, duplicate English elsewhere, versions
  with restore, and a line note.
- **Glossary mid-project**: select a word in the English (and optionally its Japanese in the same
  line) and click "Add to glossary", or use Add term in the Glossary screen or Inspector. Mori then
  shows how the term is used: lines that already use it, your translations that don't (with a Review
  button that filters the Matrix to that term), locked lines it leaves alone, and AI drafts that will
  be redrafted. Changing a term's Japanese offers to replace the old wording in your unlocked lines
  from an approved before/after list. Terms match plurals and possessives ("lantern" finds "lanterns").
- **AI drafts ahead** (desktop): Mori keeps AI drafts ready for the next N lines after the current one
  (Settings, default 100), five lines per Codex request. Drafts only go into the AI draft column;
  curated and locked text is never touched. A draft that misses a glossary term is redone once, so new
  terms reach upcoming lines without redrafting the whole file. The status bar shows progress; click
  it to pause.
- **Characters, Glossary, Context, Project & files, Settings**: editable. Projects can be renamed,
  downloaded as `.mori`, or deleted.
- **Shortcuts**: F1 lists them. Any shortcut can be rebound; a key already in use is swapped with the
  other action. Stored per browser. Ctrl+K searches actions, characters and lines.
- **Import (New project wizard, Ctrl+N; "+" next to Files adds files to the open project)**: three steps.
  Sources: JSON, CSV/TSV, TXT, PO, JS/TS, DOCX, XLSX, from files, a folder (recursive) or drag and drop,
  or a public Google Sheets link. Spreadsheets find their header row below title rows (adjustable per
  source). Sources are grouped by their header row; each group's mapping is guessed from header names and
  content (a mostly-Japanese column is the translation, a unique code column the ID, English prose the
  source). Only the source text is required: lines without an ID get "file:row" IDs, and repeated IDs get a
  suffix. Adding files to a project reuses its characters, turns new speakers into characters, and skips
  lines it already has from the same file.
- **Export back to the original files** (Project & files): each imported file is kept unchanged in the
  project, and export writes the translations into a copy of it: the translation column (or a new
  "Japanese" column) of spreadsheets, in place of the English for JSON, PO, scripts, text and Word. XLSX
  keeps styles and other tabs; a Word paragraph's text goes into its first run. Several files download as
  one zip. Projects imported before this get it by adding their files again.
- **Templates**: saved characters, context and glossaries, reused in projects. Saved templates are
  copied in, so editing a template never changes existing work.
- **Saving**: on Windows desktop, projects use an isolated native JSON store with atomic writes
  and recovery snapshots. In a standalone browser, IndexedDB remains the fallback. A cached
  library index is kept in localStorage. Edits autosave about 0.4 s after you stop typing.
  Failed saves stay on screen and retry. Independent .mori backup export is available.
  Public Google Sheets import uses native read-only network access. Authenticated Google Workspace connections and manual synchronization to Monku-created copies are now available.

## What isn't built yet

- **Google Workspace**: The desktop app includes a re-used installed-app OAuth client registration from the original Monku (no old user tokens); it opens the local user’s browser for OAuth sign-in, lists their Docs/Sheets, creates explicit Drive copies, reads all supported Sheets tabs or a DOCX export, and builds per-row copy links when a Japanese column is mapped. Project & files offers manual curated-only sync with remote cell checks and conflict refusal. Original Drive sources cannot be modified. Note: the Google account and OAuth test-user permissions still require an actual user sign-in smoke test. Google Docs round-trip writing and background auto-sync are not yet implemented.
- **ChatGPT subscription workflow**: the desktop app embeds ChatGPT in its own persistent browser partition, not T3’s account. Per-project browser sessions keep the conversation URL even after a tab is hidden, and re-open it when selected. The app reuses T3’s exact ChatGPT webview automation, guest-DOM inspection, and conversation-identity logic. The user can send an explicitly composed line/context prompt and capture a completed assistant reply into the AI **draft**, without replacing curated text. This is an early integration: login, send confirmation and long-running session behavior still require real account testing.
- **Cost-controlled subscription translation**: Monku 0.5 uses an independent Codex CLI invocation pinned to `gpt-6-luna`, `model_reasoning_effort=low`, read-only sandbox and ephemeral sessions, without model fallback. From ChatGPT chats, translate one selected unlocked/untranslated line or prepare up to five lines; only accepted suggestions become AI drafts. The separate embedded ChatGPT conversation remains available for manual discussion and is not the automatic translation engine. Codex CLI and the user\'s own subscription sign-in must exist on her PC. A live QA invocation on 2026-10-20 verified the correct model and low reasoning but failed with HTTP 429 subscription rate limiting; no other model was tried. Schema-mapping suggestions remain disabled.
- **Export back to Google Sheets** goes through the manual sync of Monku-created copies (Project & files);
  public-link sheets export as CSV.
- **Matrix on very large projects**: rows aren't virtualised yet.
- **Japanese UI**: the interface is English only.

## Build and test

From `apps/mori-web`:

- Type-check: `node ../../node_modules/.bin/tsc -p tsconfig.json --noEmit`
- Unit tests: `node --experimental-strip-types --test src/model.test.ts src/insights.test.ts src/importers.test.ts src/importPlan.test.ts src/shortcuts.test.ts src/exporters.test.ts src/google-sync.test.ts src/chatgpt-sessions.test.ts`
- Build (updates `dist/`): `../../node_modules/.bin/vp build`
- Dev server: `../../node_modules/.bin/vp dev --host 127.0.0.1 --port 5748`

The UI hasn't been checked in a browser since the rebuild; that needs a manual pass.
