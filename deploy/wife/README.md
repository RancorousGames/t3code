# Windows 11 setup: T3 Code + Monku no Mori

This deliberately uses a **separate source checkout on her PC**, not a copy of
the developer's installation or Windows user profile. Git contains code only;
Monku projects, ChatGPT logins, T3 sessions, Google logins and provider tokens
remain local to her Windows account.

## First time (one PC)

Open PowerShell, install prerequisites:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e
winget install --id Python.Python.3.13 -e
```

Open a **new** PowerShell after installation (to refresh PATH):

```powershell
npm install -g pnpm@12.14.0
git clone https://github.com/RancorousGames/t3code.git "$env:USERPROFILE\t3code"
& "$env:USERPROFILE\t3code\deploy\wife\Update-Wife.cmd"
```

If the repository is private, GitHub may request authorization on the first
clone/pull. Give her account read access rather than copying your own GitHub
credentials. Deployments use the `wife-deploy` branch because the fork's GitHub `main`
has diverged from the developer's local `main`. Push the local main commits
with `git push origin main:wife-deploy` (fast-forward only); uncommitted changes
are not included. The updater switches an initial `main` clone to `wife-deploy`.

The first successful update creates three Desktop shortcuts: **T3 Code
(Custom)**, **Monku no Mori**, and **Update T3 + Mori**. Future updates:
**push commits on your PC; she clicks Update T3 + Mori**. The updater refuses
non-fast-forward merges and local tracked edits; it never resets her checkout.

Do not put projects inside the git checkout. Monku data stays at
`%APPDATA%\MonkuNoMori`; T3's local data remains independent of
the developer's. Both are preserved by source updates.

## T3 remote support

On **her** T3 instance open **Settings → Sharing & access**. Either sign into
the same T3 Connect account you use to connect to machines (then select her
environment on your T3), or enable Network access and use a one-time LAN
pairing link. Tailscale/pairing can extend this outside the house without
sharing a T3 Connect login. Windows does not provide the T3 background service;
leave T3 running when you need to access her environment.

T3 remote connection grants access to T3 projects, sessions and agents. It
is **not Windows Remote Desktop** and does not itself let you click arbitrary
Windows programs.

## Optional Monku Google Sheets login

`apps/mori-desktop/private/google-oauth-client.json` is intentionally excluded
from Git. If Google Workspace login is needed, transfer only that OAuth client
configuration separately, then restart Monku (or configure it in Monku). Do
not copy your Google or ChatGPT login tokens. Back up her `.mori` projects
periodically.

## Update behavior

Close **Monku no Mori** before clicking Update; T3 can be running. The update
downloads the latest wife-deploy branch, installs changed dependencies, builds both
apps, safely restarts T3, and opens Mori. On a first install with no browser
sessions, T3 uses its fresh-profile launch path. The log is at
`%LOCALAPPDATA%\T3MoriDeployment\update.log`.

A missing tool, build failure, uncommitted local edit or non-fast-forward
history stops the update with an actionable message instead of doing a hard
reset. Keep the current application profile and repository directory for
subsequent runs.
