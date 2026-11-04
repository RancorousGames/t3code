# T3 Code + Monku no Mori — other-PC updater

The other PC gets an independent checkout and local profiles. The updater is
maintained inside Git, not in a standalone script on anyone's Desktop.

## First-time changeover from the old .ps1

Copy **`deploy/wife/T3-Monku-Updater.exe`** from this repo to the other PC
Desktop and double-click it. It also works on a fresh Windows PC with no
checkout: the EXE embeds a minimal installer and clones from GitHub.

The EXE checks/installs Git, Node, Python 3.13, and pnpm as needed, updates
`%USERPROFILE%\t3code` from **GitHub `main`**, builds Monku and T3,
and launches them. Existing `wife-deploy` checkouts fast-forward to `main`;
local edits, profile data and accounts are never reset.

Once installed, the desktop shortcut **Update T3 and Monku** points to the
**repo-owned** `%USERPROFILE%\t3code\deploy\wife\T3-Monku-Updater.exe`.
Future updates are a double-click. The obsolete Desktop
`Install-T3-Monku-Latest.ps1` can be deleted once this works.

The EXE automatically stages a temporary copy outside the checkout before
pulling, so the repo can update the running launcher safely. It fetches new
installer logic first and then invokes the current
`deploy/wife/Install-T3-Monku.ps1`, instead of executing a stale Desktop file.

## Update behavior

- **Close Monku first.** The updater refuses to modify anything while it is
  open, rather than discarding unsaved translations.
- Existing T3 sessions are preserved through the T3 backup/restart workflow;
  T3 may momentarily disconnect during its own rebuild.
- Git updates use fast-forward only. A wrong remote, unrelated branch, local
  tracked changes or build failure stops the update without hard reset.
- Monku projects remain at `%APPDATA%\MonkuNoMori`, independently of Git.
  T3 browser sessions and all credentials remain on their own PC.

The updater shows progress/errors in its own window. Log:
`%LOCALAPPDATA%\T3MonkuInstaller\install.log`.
For remote launch it supports `--headless` and writes
`%LOCALAPPDATA%\T3MonkuInstaller\launcher.log`, returning the real exit code.

## Repo maintenance

- Install/update logic: `deploy/wife/Install-T3-Monku.ps1`.
- EXE source: `deploy/wife/UpdaterLauncher.cs`.
- Rebuild the versioned EXE after changing either file using
  `deploy/wife/Build-Updater.ps1` on Windows, then commit the generated
  `T3-Monku-Updater.exe` with the source. The Windows .NET Framework compiler
  is sufficient; no extra SDK is required.
- `Update-Wife.ps1` / `Update-Wife.cmd` remain as compatibility launchers.
- `Publish-Wife.cmd` publishes committed main and mirrors it to
  `wife-deploy` only for compatibility with older setups.

## Linked T3 remote updates

Linked environments can maintain a connection to the other PC, but linking
alone does not confer Windows desktop access or arbitrary shell execution.
A remote updater trigger has to run explicitly on the other PC, where this EXE
can execute headlessly. Updating T3 may interrupt the link during restart.

## Optional Monku Google Sheets login

`apps/mori-desktop/private/google-oauth-client.json` is intentionally excluded
from Git. Configure OAuth separately on the other PC; never copy account tokens
or Monku projects between Windows profiles.
