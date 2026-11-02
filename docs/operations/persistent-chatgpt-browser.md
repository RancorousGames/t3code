# Persistent ChatGPT browser host — T3-0226

## Scope

Only T3-managed ChatGPT sessions (thread IDs prefixed t3-browser-session:) may opt in. All ordinary browser previews retain Electron webviews. Existing T3 panel layout displays Chromium frames; there is no user-visible separate Windows window.

The browser owner is a detached Electron offscreen Chromium process, using a never-shown BrowserWindow with skipTaskbar, offscreen rendering and separate persistent profile. It outlives T3 disconnections and restarts: pages and JS heaps remain in memory. A PC restart loses the heap but preserves browser storage. T3-0227 separately handles offline transcript caching.

Raw Playwright headless Chromium was challenged by ChatGPT. The offscreen Electron Chromium host loaded the ChatGPT homepage without a challenge, with hidden native window and no taskbar entry.

## Code

- scripts/persistent-chatgpt-offscreen-host.cjs: dedicated browser owner, exact ChatGPT HTTPS attach, persistent guest reuse, rendering, keyboard/mouse/text/evaluate, memory, and explicit shutdown.
- scripts/persistent-chatgpt-browser-host-launch.mjs: detached process launch, health, reconnect, authenticated owner token.
- apps/desktop/src/preview/PersistentChatGPTBrowser.ts: native IPC, only trusted T3 renderer controls host.
- apps/web/src/browser/PersistentChatGPTSurface.tsx: paints browser frames in existing T3 browser pane; keyboard/mouse/paste and DOM inspection bridge.
- apps/web/src/browser/ElectronBrowserHost.tsx: only opt-in ChatGPT sessions use new surface; all other webviews remain.
- The per-session localStorage key is t3:chromium-session:<UUID>. T3 ChatGPT sessions now use persistent Chromium by default; value disabled explicitly opts a session back into the native Electron webview. Ordinary non-ChatGPT webviews are never affected.

## Evidence

- Real hidden offscreen Electron loaded ChatGPT with no separate visible window; paint and screenshots worked.
- Two independent client processes reached the same persistent browser process and the same JS state: a counter advanced 1 -> 2, no navigation.
- Native input inserted T3 Chromium hello into a focused textarea exactly.
- Input ordering: concurrent independent requests were observed arriving as ACDB. The T3 surface now sequences outbound input promises per session, and the host sequences accepted requests. A focused check verified ABCD and a native mouse click on a page button.
- The opted-in preview coordinator creates a metadata-only slot (no second ChatGPT URL navigation), and preserves any currently mounted native Electron guest rather than hot-swapping its JS heap.
- The native T3 preview-operate authorization gate applies to embedded Chromium. Electron partitions are independently keyed by T3 environment and browser-profile ID. Incognito profiles remain memory-only. An isolated cookie test proved profile A cookie was invisible to profile B and cross-profile same-ID reattachment was rejected.
- Offscreen paint events cache the latest native frame per session. T3 requests a JPEG only for changed frame sequence numbers while visible, and passes its tab zoom factor. Isolated frame-cache smoke produced a JPEG, then an unchanged cache hit, and a fresh JPEG after zoom.
- Bounded screenshot capture retry handles transient cold UnknownVizError without reloading the page.
- Baseline current T3: 16 native ChatGPT sessions averaged 229 MB renderer working set/session. Offscreen unauthed homepage: 156-166 MB renderer working set; not a like-for-like after-migration comparison.

## Unfinished

- Verify first-class UI rendering and full mouse/keyboard/IME parity in an isolated T3 environment.
- Reconcile existing native preview CDP agent automation and recovery, safe drafts and uncertain sends, browser popups/login, downloads and file picker.
- Default-profile migration now transfers scoped ChatGPT/OpenAI cookies entirely within native processes and seeds Chromium Local Storage, IndexedDB, and WebStorage before first partition use. The source profile remains untouched. Verify nondefault profile and incognito cases; preserve already-mounted native guests until restart.
- Verify an actual authorized full T3 relaunch while generation is streaming, and measure matched before/after authenticated session memory.
- **Rollout deployed 2026-10-30:** independent host PID 34796 and instance ID d158ddcc-069f-4be4-83a0-57da75727b6c survived the 18:28 T3 full restart; a real ChatGPT conversation kept exact performance.timeOrigin 1793381197089.7 and an in-page JS witness. This proves one live JS heap survived without navigation. Cookie-only migration produced the ChatGPT error screen; copying native Local Storage, IndexedDB, and WebStorage fixed it for a signed-in default-profile conversation (composer present, authenticated account API 200). The storage import is now automated once per profile before the first host guest attaches; further cross-profile and active-generation checks remain.

Existing dirty source changes owned by other agents must not be staged or committed.
