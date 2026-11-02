# T3-0226 — Stable embedded browser host (replacement architecture)

**Decision:** Use handover **Backup C**. The native-overlay/JPEG prototype is archived at `t3-0226/native-overlay-prototype` (tip `81d0e98c1b`). Main has reverted its four native-overlay changes with `a776953e7e`; the already-running external Chromium host remains unchanged and must not be restarted merely to test this design.

## User's non-negotiable requirements

- ChatGPT must be a genuine Chromium-rendered part of the **same T3 window**. **No JPEG/video/image streaming**, and **no separate overlaid desktop window**.
- Normal click, text, selection, scroll, IME, clipboard, drag/drop, file pickers, focus and native popup handling must be handled by Chromium, not synthetic T3 mouse/keyboard relays.
- Replacing the T3 UI/backend must not reload the ChatGPT page, lose an unsent draft or interrupt generation.
- All T3 ChatGPT sessions remain independently identifiable and inspectable by T3's authenticated automation/agent APIs.
- Multiple pages share one Electron browser process and browser services; a tab remains live when its panel is hidden.
- No loss of the existing 12 persistent pages in the old external host during development/migration.

## Architecture

### One stable Electron _window owner_

The **single stable Electron main process** owns:

1. T3's existing main `BrowserWindow` (and its replaceable T3 UI `webContents`).
2. A session registry of independent Electron `WebContentsView` instances, one per ChatGPT UUID. All views are native children of `BrowserWindow.contentView`, positioned by validated UI layout rectangles.
3. Stable session partitions, permissions, downloads and native browser-facing automation. The browser `WebContentsView.webContents` belongs to the owner, not the T3 UI DOM.

T3's **backend/service process** remains replaceable and can reconnect/restart without terminating this owner. T3 UI is also replaceable by `mainWindow.webContents.reload()` or a new UI navigation; neither disposes the browser views.

The UI renderer reports panel bounds/visibility with an authenticated desktop IPC channel. Main validates the sender is the trusted T3 UI `webContents`, session identity and URL origin; no untrusted page receives T3 privileged IPC. Its session registry owns views independently of React mounts. On tab switch, move/show/hide the view; never navigate or dispose it.

**Use the existing Electron BrowserWindow**, not a new BaseWindow, for initial adoption: it already supports T3's extensive IPC, preload, menus, snapshots, native file/clipboard operations and app lifecycle. Reusing `DesktopBrowserHost` / its CDP relay for direct `WebContentsView.webContents` is preferable to inventing a new automation protocol.

### Restart semantics

The old `compile_and_launch_t3.py --full-restart` terminates the current Electron owner; **this cannot preserve a page it owns**. Add a distinct service/UI replacement path that:

1. Stages a new UI bundle and backend build without replacing the loaded stable main binary.
2. Restarts only the backend or reconnects it to the same stable host.
3. Reloads/replaces only the UI renderer, not any `WebContentsView`.
4. Rebinds the UI IPC/subscriptions and the browser panel geometry by session UUID.
5. Leaves active ChatGPT DOM/JS, drafts, timers, network connections and renderers untouched.

Any change that _requires restarting the stable main process_ is a maintenance/host upgrade and cannot guarantee live-page preservation; defer it until pages are quiescent, preserve the existing host, or request explicit approval. Long-term, move frequently revised handlers into the backend/service so the stable owner becomes small and rarely changes.

### Presentation nuance

`WebContentsView` is **native child content in the same T3 window**, and Chromium directly handles rendering and input with no copy/encoding transport. It is not an HTML descendant in T3's React DOM: ordinary React `z-index` cannot automatically cover a native child view. T3 must send exact panel bounds/visibility and explicit overlay/occlusion events or order other views appropriately. This is a _much smaller issue_ than cross-process top-level HWND overlays, but must be tested with menus/popovers, window resizing, multi-monitor DPI and multiple simultaneous panels before rollout.

## Isolated proof — **PASS** (2026-10-30)

Harness: `D:/SSDProjects/_AgentScratch/Tasks/T3 Code/T3-0226/Temporary/stable-host-embedded-spike.cjs`.

Created a single `BrowserWindow` containing a **native `WebContentsView` child** with its own renderer and persistent editor fixture; no separate overlaid window, JPEG stream or Chromium frame forwarding. The desktop script used global `aispeak.py` to say `start`, waited two seconds, and announced `done` afterward.

| Phase                    | Result                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Initial child view       | UI renderer PID **19108**; browser renderer PID **26200**                                         |
| Backend process restart  | **PASS**; browser token, JS timer, draft preserved                                                |
| T3 UI reload             | **PASS**; browser PID and JS time origin unchanged; draft and scroll preserved                    |
| Forced UI renderer crash | **PASS**; old UI renderer **19108** crashed; new UI renderer **25372**; browser remains **26200** |
| After recovery           | Same browser token, JavaScript timestamp, unsent draft, 180px scroll, timer advances              |

Raw evidence: `Temporary/stable-host-embedded-result.json`, `Temporary/stable-host-embedded-window.png`. The harness exits and closes its scratch profile; normal T3 and the production external browser host were not restarted.

**Limits:** The harness uses a local HTML fixture, not an authenticated ChatGPT session, and programmatic fixture text setup, not an end-to-end physical typing/IME test. The proof demonstrates native view ownership and lifecycle, not full T3-specific UI/IPC integration. Existing pages in a _different_ Electron process cannot have their existing `webContents` moved into this host. They must remain in that old host until an explicitly approved cutover, with a one-time page reload and possible loss of ephemeral page state, or be retired naturally.

## Implementation slices (in order)

1. **Stable View Registry:** Add isolated, session-keyed `WebContentsView` manager beside `DesktopWindow`; allow direct presentation in the existing BrowserWindow. Guard session UUID, environment/profile partition and ChatGPT-only URL. Hiding a panel must not close its `webContents`. Test independent UI reload and crash.
2. **UI binding:** Replace ChatGPT's generic Preview and JPEG/overlay adapters with a placeholder and authenticated bounds/visibility/occlusion IPC. Browser remains the default session view; T3 continues rendering sidebar and controls around it. Preserve session URL tracking and status.
3. **Backend + automation parity:** Adapt existing CDP relay/inspection to persistent `WebContentsView` ownership. Maintain safe-send, uncertainty handling, downloads, native dialogs, input and authentication scope.
4. **Restart controller:** Implement staged UI/backend reload with the stable Electron owner alive; add distinct host-upgrade semantics. Verify no renderer/JS time-origin changes across service restarts, UI reloads and forced UI crashes.
5. **Acceptance test:** Inside isolated full T3, open 2+ ChatGPT test sessions. Verify physical typing, click, scroll, text selection, clipboard, IME, file operations, popovers, split panels, resizing, DPI, accessibility and response latency. Capture before/after state across restart and crash.
6. **Cutover:** Opt in new sessions first; keep existing external-host sessions untouched. Offer an explicit, honest migration decision for pages that cannot be transferred without a reload. Only retire old transports after all requirements are met.

## Do not do

- Do **not** attempt to transfer live Electron `WebContents` between main processes.
- Do **not** claim that killing the entire stable Electron host can preserve its views.
- Do **not** misrepresent `WebContentsView` as a DOM child with native CSS stacking.
- Do **not** restart the production external host or destroy any of its live pages without user permission.
