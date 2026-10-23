# Monku no Mori — Product Purpose & UI Requirements
## Design brief for Claude, based on the original Monku no Mori

**Purpose of this document:** Describe what Monku is trying to accomplish and what users must be able to do. It is a **product/interaction brief**, not a request to duplicate the old interface pixel-for-pixel or a list of prescribed visual components.

**Companion:** [COMPONENT_CATALOG.md](COMPONENT_CATALOG.md) documents the actual T3 UI components available in the new skeleton. Use those components, and the live **T3 UI Kit** page, as the building blocks. This document describes **what the UI needs to enable**.

**Where to look:** Original Monku lives at `D:\SSDProjects\MonkuNoMori` (especially `conductor/product.md`, `Features.txt`, `app/src/features/`, `app/src/components/SmartBox.tsx`). The new skeleton lives here under `apps/mori-web`.

---

# 1. The goal: why Monku exists

**Monku is a professional workbench for translating and localizing games into Japanese.** It is not just an AI chat window, a spreadsheet clone, or a button that translates an entire document.

Game localization is unusually context-dependent. A sentence can be grammatically correct and still be **wrong for the game**:

- A character may be formal with strangers but casual with a sibling.
- A gruff merchant, ancient monarch, sarcastic teenager, and system menu should not sound like the same speaker.
- A term may have a canonical in-universe translation, even if a different Japanese word seems more natural in isolation.
- An ambiguous English line may depend on the surrounding dialogue, setting, or events.
- Translators must preserve game-specific identifiers, placeholders, control codes, line breaks, and other structural details.
- One game may distribute its text across dozens or thousands of strings in JSON, spreadsheets, scripts, or documents.
- Existing human work, developer-provided Japanese, and approved terminology must remain usable—**AI must not casually replace them**.

The user's central problem is **consistency and context**: AI models can generate fluent Japanese quickly, but they do not automatically know a game's conventions, characters, established translations, and narrative voice. The human translator knows these things but should not have to repeat them for every line.

**Monku's answer is a unified localization workspace:**
1. Import and organize game text from different sources.
2. Define project-wide translation rules, terminology, and character speaking styles.
3. Make that context available to AI translation workflows.
4. Let the translator review, edit, accept, reject, regenerate, and finalize results quickly.
5. Safely preserve the human's decisions and export the work back to its required source format.

The intended experience is **AI-assisted human translation, with human-curated text as the authority**. The AI is a fast collaborator, not the owner of the finished script.

A good UI should make a session feel like this: *open a project, see exactly what needs attention, understand the context for a line, compare the existing and proposed translations, make a decision in seconds, then move to the next line.* It should scale from repetitive menu strings to nuanced dialogue without forcing constant navigation or prompting.

The primary user is a knowledgeable translator working extensively in English and Japanese. Favor **long-session productivity, clarity, quick editing, and confidence in what has been saved** over decorative dashboards or elaborate agent orchestration.

# 2. Boundaries and design freedom

- **Preserve behaviors, not the previous layout.** You may reorganize navigation, improve workflows, combine redundant screens, rename confusing labels, or introduce better contextual inspectors. Don't feel compelled to reproduce the original side panels or exact arrangement.
- **Keep the UI information-dense but readable.** Translation involves comparing many rows and long Japanese strings. Prioritize usable text space, easy scanning, and keyboard-friendly interactions.
- **Use T3 Code's existing UI components** rather than recreating buttons, inputs, menus, badges, dialogs, overlays, and other standard primitives. Prefer composition. Don't make unrelated changes to T3's original UI kit.
- **Avoid prematurely specifying a visual theme.** The original favored dark/cyberpunk styling and emerald for verified work. Treat that as inspiration, not a constraint. Choose a coherent design with strong hierarchy and sensible status colors, but make the work itself the focus.
- **Avoid fake functionality.** If AI, Google sync, persistent storage, or a backend process isn't wired up yet, show an explicit disconnected/not-implemented state or a disabled action; do not simulate successful operations.
- **Do not redesign the original Mori's mistakes as requirements.** An old button or state machine existing in the code does not guarantee it worked correctly. Preserve its user intent, verify behavior before porting.
- **This is not coding-agent software.** Reuse T3's AI session platform and UI primitives, not Git worktrees, code checkpoints, pull request workflows, terminals, or developer-centric UI by default.
- **Separate users and machines:** Monku is installed on the translator's PC, independent of the developer's own T3 installation. Updates will be published to her as a separate app. Her projects, credentials, data, AI conversations, and translation work must not be mixed with the developer's environment.
- The developer has a **Monku software-project manager** in their own OpenRig hierarchy. That is **not** a manager of the translator's localization projects. Do not surface that hierarchy in Monku.

# 3. The core data concepts the interface must communicate

These distinctions are critical because most mistakes in a localization tool involve editing or losing the wrong version of a string.

**Localization project:** A game or other translation job with a name, source files, imported strings, its own terminology and character descriptions, project context, metadata, and optionally a deadline/sync configuration.

**Translation string/segment:** A stable identifier and source text, with optional speaker/character, source file/location, multiple translation versions, status, and history.

**The versions of a string are different things:**
- **Source / raw:** The original text to interpret and translate (typically English), plus identifiers and formatting tokens.
- **Developer or legacy draft:** Japanese supplied by the developer or an earlier machine-translated source. Useful reference, not authoritative final text.
- **AI draft:** Suggested translation(s), potentially with a short explanation and confidence/context notes.
- **Curated / human translation:** The translator's edited or accepted wording. This is the working deliverable.
- **Final / locked:** A deliberate protected/approved state. AI regeneration and batch operations must not overwrite it without an explicit, clear unlock/override action.

The old UI also used **Pending**, **Draft**, and **Translated** row statuses. Treat *workflow progress*, *which version is being displayed*, and *whether a string is locked* as related but separate concepts. Do not make "translated" silently imply "locked", or vice versa, unless the user explicitly chooses that workflow.

**Version history:** The translator should be able to inspect earlier developer, AI, and curated versions and deliberately restore/copy one. Editing should not erase prior human work. Show enough history information to understand where a version came from.

**Characters:** At present, the model is intentionally simple:
- **Name** (display name).
- **Role** (e.g. protagonist, shopkeeper, narrator, system).
- **Tone/speaking style** (e.g. formal, rude, playful, polite, tsundere, system-neutral).
- **Free-text description** including personality, characteristic phrases, pronouns, social standing, vocabulary, or localization notes.

**Do not invent an explicit character relationship graph, fact-knowledge graph, or timeline editor in this UI pass.** The developer specifically deferred those. More sophisticated factual context may later be supplied by OpenRig's knowledge layer, but the visible Character Engine should start with the straightforward existing definitions.

**Glossary item:** Source-language term, canonical Japanese rendering, and explanatory/contextual note. **Excluded/ignored terms** are a separate concept for words the translator does not want Monku to analyze or suggest repeatedly.

# 4. Navigation and overall interaction model

The user must be able to **readily switch between**:

- The library of localization projects and their source files.
- A **Matrix** view for comparing and editing many strings at once.
- A more focused **Streamliner** view for translating individual lines or small groups.
- Characters, glossary, and global/project translation context.
- Import/export and Google Workspace actions.
- AI assistance and conversations, when the T3 session integration exists.
- Settings, keyboard shortcuts, diagnostics, and relevant sync/activity status.

It is more important that these destinations are **predictable and fast to access** than whether they use a permanent sidebar, tabs, a command palette, or contextual panels.

The original application used Projects / Matrix / Streamliner as primary destinations, with quick-access Character, Glossary, Context and Settings panels. That separation worked conceptually: **the translator should not need to leave the row they are editing to check or correct a character definition or glossary term**. Consider contextual overlays/panels or split views for reference material.

Always make it obvious which localization project is active. Switching projects must not silently discard unsaved work or leave the user working in the wrong game's context.

Use clear empty states (no project, no strings, nothing matching a filter), actual progress states, recoverable error messages, and honest save/sync feedback. Avoid permanent banners that eat into the working area.

# 5. Project library and file organization

The user should be able to:

- Create and name projects; import a project; search/filter the project library; quickly open/switch between projects.
- Recognize the active project and optionally choose which project opens at startup.
- See at-a-glance progress: total strings, completed vs remaining, number of characters, last edited, and optionally deadline.
- Browse which source files belong to a project, including multiple imported sources. Ideally open/reveal a source file when relevant.
- Export a completed or in-progress localized result, or manage its Google Workspace connection.
- Safely rename/manage/delete projects, with confirmation for destructive operations and no accidental loss of translation work.
- Find relevant strings or files without knowing their internal IDs.

Project statistics help orient the translator, but they should not dominate the application or displace the text-editing workflows.

# 6. Import, unification, and source inspection

A key Monku promise is to **hide the fragmentation of localization file formats** behind a coherent editor.

The UI needs a comprehensible import flow where the user can bring in **one or many files, whole folders**, and eventually Google-hosted content. The original supported or planned workflows for **JSON, CSV, TXT, PO, JavaScript/script files, XLSX, DOCX, and Google Sheets/Docs**. Formats may require different adapters; never falsely claim that every format is equally supported until verified.

Important interaction requirements:

- Easy file/folder picking (and drag-and-drop where appropriate), with a visible list of staged sources.
- Preview a source **before committing the import**, ideally distinguishing raw original content from extracted/translatable rows.
- Identify imported files, paths, sheets/groups, likely schema, and any incompatible/missing fields.
- Support mapping source columns/keys to the unified model: row ID, source text, previous/developer translation, character/speaker, and related metadata.
- When files use different schemas, make their mappings understandable rather than silently merging mismatched fields. The original importer grouped sources by schema.
- Offer intelligent schema and speaker detection later, with the ability to inspect/correct AI guesses.
- Name the resulting project and understand the consequences of import or reimport.
- Explain invalid files, missing mappings, unsupported formats, or extraction failures clearly; do not create partially mangled projects with no warning.

**Critical trust requirement:** The app should not modify the user's original imported files unexpectedly. The original product explicitly called for a "Never Edit Original" safeguard. Imported Google documents should be copied to an editable synchronization copy unless the translator explicitly chooses an appropriate alternative.

# 7. Matrix: the primary editing workspace (highest priority)

This is the most important and most frequently used part of Monku.

The Matrix is a **high-density localization grid** that lets the translator rapidly compare original text, reference translations, AI suggestions, and their chosen final wording.

For a typical visible row, the user should be able to find or do the following with minimal effort:

- Identify the segment (stable ID, filename/location if needed) and its assigned speaker/character.
- Read the **source English** and its line breaks/placeholders.
- Compare the **legacy/developer Japanese**, if present.
- Inspect the **AI suggestion** and any useful explanation/confidence information.
- **Edit the curated Japanese directly**, or accept an AI suggestion into a human-editable version.
- See progress/status and whether the line is protected.
- **Mark it complete/verified and lock/unlock it intentionally.**
- Access its version history and previous variants.
- Trigger an individual AI translation/regeneration when available.
- Navigate to the next string needing attention without losing keyboard focus or momentum.

Across the full Matrix:

- Search by ID, source text, speaker, and other useful fields.
- Filter by status (all/pending/draft/translated); useful combinations like unreviewed or locked can be added if they aid real work.
- Quickly jump between specific rows and adjacent lines. Keyboard navigation/editing is particularly important.
- Show/hide and resize columns to fit the task, and remember practical workspace preferences.
- Make the current row and edited field easy to track across a wide table. Handle long source and Japanese text, line breaks and wrapping well.
- Keep important labels/headers accessible when scrolling. Large projects need efficient rendering/virtualization rather than mounting thousands of heavy editors.
- Show real queued/running/failed AI or sync states at row level so the user knows what actually happened.
- Offer clear batch operations and access to export without requiring a navigation detour.

The old Matrix had per-row speaker selection, single-line translation, AI-to-curated promotion, confidence/explanation, duplicate-link indicators, status filtering, column visibility/resizing, and export actions. Treat those as **interaction goals**, not necessarily exact button placements or hover behaviors.

Make destructive or broad AI actions obviously different from ordinary edits; confirmation/preview is preferable when the action might affect human work.

# 8. Streamliner / focused translation

The original also had a **Streamliner** for a more immersive, line-oriented workflow.

It should serve a distinct purpose from the Matrix: less table management, more attention to the actual words.

The translator needs to:

- Focus on one segment or a manageable sequence while retaining source text, speaker and relevant context.
- Edit the chosen Japanese naturally with minimal visual noise; get to the next/previous line quickly.
- Switch or compare **Raw/Source, Dev Draft, AI Draft and Curated** content.
- Inspect past versions and compare revisions without confusing the historical view with an editable current version.
- See protection/completion state and explicitly approve/lock a translation.
- Invoke AI variants, context questions, or retranslation where they add value.
- See character speaking style, explanation, word count/length hints or other context only when useful.
- Perform batch-generation/regeneration with an intelligible **Keep Curated / protect existing work** policy and clear preview of what will change.

The old Streamliner displayed translation "smart boxes" with source and translation, character, history arrows, linked duplicate indicators, and quick assist actions. You can redesign the form factor entirely as long as the focused, rapid-review workflow remains.

# 9. Characters, speaker assignment, and tone

**Character style is central to the product's reason for existing.** A generic fluent translation is not enough if every character sounds identical.

The UI should let the translator:

- Create, find, inspect, edit, and remove character definitions with the existing **name / role / tone / description** fields.
- Write free-form, nuanced linguistic guidance (Japanese pronouns, honorifics, formality, verbal habits, idiosyncratic word choices, personality, etc.).
- Assign a speaker to one or many dialogue strings quickly, directly from the Matrix or focused editor.
- Create a new character while assigning a speaker, without navigating away and losing the current line.
- Distinguish genuine named characters from narrators, generic NPC classes, and system/UI strings.
- See which style/context the AI is expected to use for the current line.
- Later, review AI-suggested speaker detection and correct uncertain assignments.

The UI should make character voice a practical translation tool rather than a disconnected character encyclopedia.

**Scope constraint:** Keep definitions simple now. Explicit interpersonal relationships, chronological secrets, knowledge-of-events, etc., are not current UI requirements. They may be covered by richer project knowledge in the future rather than hard-coded forms.

# 10. Glossary, word insights, and terminology consistency

Consistency across thousands of game strings is a major quality requirement.

The translator needs a **searchable, editable glossary** with source term, preferred Japanese term, and context/explanation. Adding, editing, deleting and reusing terminology should be straightforward.

Ideally the user can select/click a word in a source line and quickly:

- Check how that word has been translated in other project strings.
- See previous Japanese renderings, usages, and contexts, and jump to those strings.
- Add it to the glossary or mark it ignored/excluded from repeated suggestions.
- Ask AI what an ambiguous English word or phrase means **in the context of this specific game and surrounding dialogue**.
- Get context-sensitive translation suggestions using project rules and glossary entries.

This is more than a dictionary: "the right translation" depends on the game's established terminology and scene. Word help should be convenient but unobtrusive; reading a line should not require a modal dialog every time.

Further work can add inconsistency detection and guided mass find/replace with contextual safeguards.

# 11. Context Studio and future knowledge integration

The original Monku has two free-text context scopes:

- **Global conventions:** User-wide translation preferences that should apply across appropriate projects (e.g. honorific policy, punctuation, terminology conventions, placeholders).
- **Project context:** Genre, setting, lore, narrative background, tone, audience, and other game-specific instructions.

These need to remain easy to review and edit. The translator should understand what context will influence AI operations and be able to correct it when results are wrong.

Monku may later use **OpenRig's knowledge layer** to retrieve and retain broader game knowledge. That is an **integration direction**, not permission to invent a separate relationship/knowledge management system in the UI now. Start with the original definitions and context editors; leave a sensible affordance for consulting expanded knowledge once the runtime exists.

A core interaction goal is to bring the *relevant* context to the place where a string is being edited—not to make the translator browse an enormous knowledge database before every line.

# 12. AI assistance and model/session interaction

AI is not a bolt-on gimmick; it is an accelerator that should consistently respect the localization project's decisions.

When the backend exists, the user should be able to:

- Choose available AI providers/models using the **real T3 session/provider infrastructure**; understand what's connected and what is not.
- Translate an individual segment or selected/batched segments, with progress, cancellation where supported, and actionable failures.
- Regenerate an AI draft or request alternate phrasings without destroying human-curated content.
- Request more detail about meaning, intent, ambiguity or word choice with game/character/nearby-line context.
- Access a normal conversation-style AI workspace for deeper questions or instructions; ideally keep project context associated with the conversation.
- See which text is an AI proposal, which text is currently human-curated, and what an AI action proposes to change.
- Understand context or glossary influences behind a suggestion when the system can actually provide that information.
- Continue working manually during long AI tasks, without losing unsaved edits or accidentally applying stale results.

**Safety principle:** Batch translation should normally operate on proposals/drafts. Locked strings must remain protected. A human translation should never disappear merely because another model answered later. Explicit overrides may exist, but require informed user intent and preserved history.

The old UI was Gemini/gemapi-focused and had a model selector, batch generation, inline generation, AI explanation, and "Keep Curated" option. The new application is intended to use T3's changing provider ecosystem instead of maintaining a separate Gemini integration.

**Do not fake working chat/model controls.** The current new skeleton's AI Sessions screen is deliberately a placeholder until a real backend is connected. This design brief doesn't require implementing the provider backend as part of visual design.

# 13. Duplicate strings, revision history, and quality review

The original UI identified repeated source strings across different files and let the translator inspect, link/unlink, and jump between duplicates.

The desired behavior:

- Recognize identical or related source segments, including source-file provenance.
- Show when two rows are linked and whether edits synchronize across them.
- Allow unlinking when the same English text needs *different* Japanese translations in different contexts.
- Avoid silent propagation into locked/curated rows.
- Make version history easy to inspect and restore, with clear labels for developer, AI and human edits.
- Offer a useful diff between AI/legacy and curated text, especially for targeted review.
- Surface **warnings**, not just errors: missing translation, mismatched placeholders/tokens, accidentally changed markup, unusually long Japanese text, or other game/UI constraints.
- Later support schema checks and small game-like text previews to see whether a line fits typical game UI/dialogue presentations (visual novel, dialogue box, menu, etc.).

Important distinction: a line can have an AI suggestion but still need human review. "Done" should mean something meaningful and explainable, not merely "a model returned text."

# 14. Import/export, saving, and Google Workspace safety

**A translator's approved work must survive crashes, restarts, imports and software updates.** Confidence in data integrity is a first-order UX requirement.

The interface should make it clear:

- Whether the active project is saved, saving, or has unsaved changes.
- What is stored locally versus synced externally.
- What an export will contain and which source files/formats it targets.
- Whether an error prevents a specific segment/file from exporting correctly.
- How to recover old edits or back out of a mistaken generation/merge when possible.

Support export back into original or explicitly chosen localization formats—not only exporting a fresh generic JSON dump. Preserve IDs, non-translatable content, placeholders, ordering and format structure where the target requires it. For formats such as DOCX and XLSX, validate round trips and avoid silently stripping unrelated document formatting or workbook content.

**Google Workspace** was an important original integration. The user should be able, once connected, to choose a file from Drive/Sheets, establish a safe editable copy, choose sync behavior (real-time, manual sync, export-only), understand sync progress and failures, and resolve conflicts without losing curated work. Prefer a strong **Never Edit Original** default with clear consequences of changing it.

File import/export, cloud sync, and app updates are separate concerns. The translator's data must not depend on the developer's PC being online. The new Monku app needs independent releases on her machine.

# 15. Settings, accessibility, and diagnostics

The original settings exposed or envisioned:

- AI account/authentication status and model selection (now via real T3 infrastructure when connected).
- AI batch behavior such as group size/window and regeneration preferences.
- Saving/autosave preferences.
- Google connection status, "Never Edit Original", default sync mode.
- Workspace density/compactness and appearance controls; readable Japanese text/font choice.
- Customizable keyboard shortcuts, with a discoverable cheat sheet.
- Language preferences: **English and Japanese UI**.
- Application diagnostics and an unobtrusive developer console/log area.

The interface should feel natural for professional English→Japanese translation. Make Japanese strings legible, respect IME composition, support keyboard navigation, and avoid trapping focus in editors or popovers. Use labels and status cues that remain understandable without relying on color alone.

The original product also intended to translate its own UI through a compatible localization bundle ("dogfooding"). Preserve that product direction when organizing interface copy.

Diagnostics should be accessible when something fails, not the central daily workspace.

# 16. A few user journeys to use as design acceptance tests

These journeys are deliberately about **outcomes**, not exact UI widgets or layouts.

**A. Starting a localization project**

The translator chooses files or a folder, checks an import preview, maps source/translation fields if needed, sees what could not be parsed, names the project, and arrives at a useful Matrix with provenance intact. Nothing original has been overwritten.

**B. Working through 100 dialogue lines**

She opens the project, filters to incomplete dialogue, reads an English line and its speaker, sees legacy and AI Japanese, edits the curated version, marks it complete/protected, and moves to the next line by keyboard. A brief glossary or character lookup doesn't make her lose her place.

**C. Fixing a character's voice**

An NPC's AI suggestions sound too formal. She opens the character's definition, adjusts their tone/description, returns to the same line, and requests a new draft. The old draft and her earlier work stay accessible.

**D. Investigating an ambiguous English word**

She selects a word, sees prior usages in the game and preferred terminology, jumps to a related instance if needed, adds a glossary entry or ignores the word, and optionally asks AI for context-sensitive meaning.

**E. Safe batch regeneration**

She selects a set of pending/draft lines, chooses an available model, initiates generation, sees actual per-row progress/errors, reviews resulting suggestions, and confirms that locked/curated translations were not replaced unexpectedly.

**F. Delivering a localized build**

She reviews incomplete/invalid lines, checks formatting/placeholder warnings, exports into the appropriate source format or a safe Google copy, receives a trustworthy success/failure report, and can reopen the project without losing decisions.

**G. Receiving a Monku software update**

The developer publishes a new Monku version for her separate PC. She updates the application without joining the developer's T3 installation, changing her localization-project ownership, or losing local settings and translation data.

These journeys are a good way to judge whether a new layout is really better than the old one.

# 17. Priority and present implementation status

The full brief describes **the product's target experience**, not an assertion that everything in the old app worked or that everything exists in the current skeleton.

| Priority | Outcome | Notes |
|---|---|---|
| **P0: UI foundation** | Clear navigation, project context, Matrix, Streamliner, characters, glossary and context editors | Must be effortless to find and understand. The new skeleton already has simple versions. |
| **P0: Trust** | Status, curation vs AI proposals, locking, safe history/recovery, clear save state | Safety must be designed into every editing flow, even while backend wiring is incomplete. |
| **P0: Practical speed** | Dense readable rows, keyboard flow, filters/search, useful source/character context | The everyday workflow is the main measure of success. |
| **P1: Data workflows** | Real project persistence, multiple-source import, mapping, source previews, round-trip export | The skeleton currently only opens/downloads `.mori` copies in memory. |
| **P1: AI workflows** | Real T3 sessions/models, individual and batch proposals, context-aware assistance | The skeleton's AI screen is **not connected**; don't simulate connectivity. |
| **P1: Project utilities** | File library, glossary word usage, duplicate links, review warnings, hotkeys | Present in varying degrees in the old code, not all in the new shell. |
| **P1: Cloud work** | Google Workspace import, safe copies, sync modes, sync/error feedback | Later integration; honor "Never Edit Original". |
| **Later/optional** | Automated character detection, advanced consistency QA, contextual mass replacement, game UI previews, deeper OpenRig knowledge retrieval | Design room for these, but don't crowd the current UI with unfinished controls. |
| **Not currently requested** | Explicit character fact/relationship graph, translator-project swarm manager UI, T3 coding/git tools | Avoid inventing these. |

**Original UI reference map:**

- Navigation and auxiliary panels: `app/src/components/Sidebar.tsx`, `Layout.tsx`, `registry/NavigationRegistry.ts`, `PanelRegistry.ts`.
- Project library: `app/src/features/projects/ProjectsPage.tsx`.
- Import/unification: `app/src/features/import/ImportPortal.tsx`.
- Matrix: `app/src/features/matrix/Matrix.tsx`.
- Focused translation: `app/src/features/streamliner/FocusMode.tsx` and `app/src/components/SmartBox.tsx`.
- Contextual word help: `app/src/components/WordDetailsPopup.tsx`, `SourceViewer.tsx`.
- Character definitions: `app/src/features/characters/Characters.tsx`, `CharacterCreationModal.tsx`.
- Glossary: `app/src/features/glossary/Glossary.tsx`.
- Global/project rules: `app/src/features/context/ContextPanel.tsx`.
- User preferences: `app/src/features/settings/SettingsPage.tsx`.
- Original domain types: `app/src/types/index.ts`.
- Product intent and future ambitions: `conductor/product.md`, `conductor/product-guidelines.md`, `Features.txt`.

## What success should feel like

A translator spending hours in Monku should feel that **the app remembers the game's rules and her decisions, makes AI useful rather than unpredictable, and gets out of the way when she is editing**.

The Matrix should be faster than editing spreadsheets by hand. The Streamliner should be more comfortable than editing disconnected text files. Glossary and character context should be close enough to use constantly. The model can help, but **the final Japanese remains unmistakably hers**.

**Claude has freedom to design the layout and visual language. The essential constraints are the translator's workflows, reuse of real T3 UI building blocks, and protection of human-curated localization work.**
