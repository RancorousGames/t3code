# Monku no Mori UI localization

Mori translates its own interface through its normal native translation project,
named **Monku no Mori · Interface**. Each row represents one English UI message.

## Refresh the source inventory

From the T3 repository root:

    node apps/mori-web/scripts/bootstrap-ui-project.cjs

Every fresh install automatically adds the bundled **Monku no Mori · Interface**
project to the project picker without opening it. Existing installations receive
new interface keys on update, keeping their saved translations, drafts and edits.
No manual `--install` command is required on another PC; the optional `--install`
flag is only for updating the local native library immediately during development.

The shared AST scanner (scripts/ui-string-compiler.cjs) inventories and
instruments UI labels, buttons, form controls, accessible labels, tooltips,
statuses, warnings and messages in the TSX UI and selected TypeScript modules.
The Vite transform adds runtime translation lookup. Static module-level
label records use live getters, so language changes affect them immediately.

Interpolated text uses numbered placeholders ({0}, {1}, etc.) that Japanese
translators can reorder. Never translate arbitrary project contents, user
created labels, identifiers, file paths or keyboard bindings.

Row IDs are hashes of the English source and remain stable when code moves.
Regenerating and installing the catalog preserves existing curated translations,
AI drafts, history and lock state. The generated .mori file is a source catalog;
the native project library is authoritative for translator edits.

## Preview

Open the interface translation project and translate via Matrix or AI Chats.
Open Settings > Language > 日本語 to preview translations. Edits to the active
self-translation project refresh live. Reload re-reads saved translations
without restarting the application.

English is used for untranslated keys. Curated translations take precedence
over AI drafts. AI drafts are previewed but remain unapproved.

## Guardrail

The Vite build fails if a new extracted UI label is absent from the
MonkuNoMoriUI.mori catalog. Run the bootstrap command after adding UI strings.
The generator and compiler use the same AST scanner, preventing silent
drift between the translation project and actual UI.

Module identifiers and user-supplied project titles, file names and custom
session titles are data, not UI messages.
