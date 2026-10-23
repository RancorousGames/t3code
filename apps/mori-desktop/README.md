# Monku no Mori desktop shell

A **separate product** within the T3 source monorepo. This Electron entry point
has a distinct Windows application identity and an independent user-data directory.
It is NOT a second copy of the existing T3 installation, and it does not connect
to the developer's T3 session database, OpenRig hierarchy, or credentials.

## Development

From the monorepo root, install workspace dependencies once:

`pnpm install`

Then run the UI:

`pnpm --filter @t3tools/mori-web dev`

Alternatively, build the UI and launch this separate desktop shell:

`pnpm --filter @t3tools/mori-web build`

`pnpm --filter @t3tools/mori-desktop start`

## Independent Windows installer

Once dependencies are installed and the web UI has been built:

`pnpm --filter @t3tools/mori-desktop dist:win`

The NSIS installer is emitted under `release/mori/` (gitignored by root).
The product identifier is `games.rancorous.monkunomori` and its user profile
is `%APPDATA%/MonkuNoMori`.

For every update, increment the version in this app's package.json, rebuild
mori-web, and generate a fresh NSIS installer. Give the versioned .exe to the
user on the other PC (for example through a shared Drive folder or a release
page). Installing it again uses the same app identity and preserves the
%APPDATA%/MonkuNoMori profile. No account or network connection to the
developer's T3 installation is needed.

**Current update method is manual**: no auto-update feed has been configured and
no release has been published. The prototype installer is not code-signed, so
Windows may show a publisher warning. A later milestone should add a dedicated,
accessible Monku release feed, an updater, and trusted Windows signing.

## Native backend tests

From `apps/mori-desktop`, run `node --test project-store.test.cjs public-sheet.test.cjs google-workspace.test.cjs`.

## Prototype limitations

The Electron app has an isolated local project backend (`project-store.cjs`):
atomic native JSON saves, recovery snapshots, a .mori open/save dialog, and
CSV/JSON/PO interchange export. The renderer calls these functions through a
narrow preload/IPC boundary without Node or unrestricted filesystem access.
The native Google Sheets fetch permits public read-only CSV through Google's
export hosts. Authenticated Drive access uses the old Monku installed-app OAuth client registration bundled as an Electron resource, not the old user's login tokens. Each Windows user signs in separately through loopback OAuth with PKCE and stores tokens under Electron safeStorage. Private Docs/Sheets import creates Monku-owned copies; manual sync writes reviewed human translations only to the copies with preflight conflict checks. Real-account OAuth consent and live API behavior require user testing.

**ChatGPT browser integration:** uses the actual T3 guest automation and inspection code inside the independent Monku Electron desktop client, in its own Chromium partition. It accepts the user’s ChatGPT subscription login and stores only tab names, project associations and conversation URLs in the Monku UI profile. It does not use developer T3 sessions or the developer’s ChatGPT account. Real-account login and response confirmation still require integrated testing.

**Low-cost translation tests:** The separate `codex-translation.cjs` backend uses a ChatGPT-subscription-authenticated installed Codex CLI with exact model `gpt-6-luna`, reasoning effort `low`, read-only workspace, ephemeral mode, and no model fallback. UI review controls save proposals only as AI drafts. A real 2026-10-20 Codex invocation reached the correct model/effort but hit HTTP 429; the app now reports subscription rate limiting instead of silently falling back. This single-run bridge is not yet a fully managed T3 Codex session runtime.\n\n**Not yet implemented:** full subscription-native T3 Codex/Claude managed sessions,
Google Docs write-back and automatic cloud synchronization, OpenRig knowledge retrieval,
exact source-preserving export of every imported format, and automatic updates.
The portable `.mori` backup is still strongly recommended.

The wife's localization projects are not children of the developer's OpenRig
global manager. The latter may manage development of Monku software only.
