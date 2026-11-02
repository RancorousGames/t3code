# T3 persistent Chromium — direct native overlay

**Updated:** November 2, 2026
**Purpose:** Render ChatGPT fluidly inside T3 while preserving the actual live pages across T3 rebuilds, hard restarts, and crashes.

## CPU scheduling invariant — November 2, 2026

**Do not disable Chromium background scheduling globally.** The detached host previously used all three `disable-background-*` / `disable-renderer-backgrounding` switches and set `backgroundThrottling: false` on **every** retained ChatGPT `WebContentsView`. With dozens of resident pages, hidden pages continued consuming substantial CPU. The host now keeps Chromium's default timer/occlusion throttling and initializes each page with `backgroundThrottling: true`; only `/sessions/visibility { visible: true }` changes that page to unthrottled, and hiding it restores throttling. Hidden pages retain their DOM and network access. Never revert this to keep one foreground page animated.

The November 2 incident contained **two different CPU sources**. A 26-page host used roughly 0.77 cores in an idle eight-second sample; after host restart and throttling restoration, a smaller 4-page resident set used 0.10 cores (the samples have different page counts and are not directly comparable). **The acute 80% machine CPU spike instead came from an orphaned headless Chrome process for the Order of the Fallen IK visual-capture scratch tool** (`--use-angle=swiftshader`), whose GPU subprocess alone used ~59% machine CPU. After terminating that orphaned process tree, measured aggregate CPU dropped from ~80% to ~12.5%. The scratch capture script now kills its full Chrome process tree in normal cleanup, not only the root PID. Keep future headless WebGL capture processes bounded and supervised.

## Direct-overlay revision — November 2, 2026

To remove DWM thumbnail interpolation/blur, T3 now positions the independent host's own top-level Chromium HWND directly over the ChatGPT panel using `SetWindowPos` and `WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`. This is a real native window, not an image, a DWM thumbnail, or a reparented child. Chromium remains owned by the detached process; the T3 renderer forwards pointer/keyboard events over its authenticated pipe, and mouse hit testing falls through the visual overlay.

The host window is shown without activation and is only visible when its T3 panel is visible and the T3 owner window has focus. Its bounds are recalculated in physical monitor coordinates on moves/resizes and on a bounded 200-ms z-order reconciliation. The native tooltip overlay is raised above Chromium. Dialogs/modal overlays hide the browser surface temporarily; no page reload occurs. The existing host's parking timer is cancelled through two idempotent visibility requests, allowing a direct on-screen window without restarting the host.

A separate two-process Electron smoke test displayed sharp source text with no intermediate image, and force-killing the target left its Chromium source process alive. This does not yet guarantee full UI z-order/focus/multi-monitor behavior; those require in-app acceptance.

The desktop broker now retries new page attaches after explicitly identified invalid sign-in cookie transfers, excluding individual bad cookies while never retrying ambiguous IPC failures. The UI retries transient presentation errors (three bounded retries) rather than leaving a permanently cached failed rectangle. The host input validation permits 8192×4320 coordinates after its next owner restart; existing live owner processes remain untouched until a deliberate migration.

## Historical DWM implementation (superseded)

## Ownership and rendering

- The dedicated v3 Electron host owns every ChatGPT `WebContentsView`, its cookies, renderer and live document memory. It communicates with T3 through an authenticated named pipe; only trusted T3 renderers can use the desktop IPC bridge.
- The host owns a **top-level, independent Windows HWND** for each page. Windows DWM composites its GPU surface into the T3 window via `DwmRegisterThumbnail` / `DwmUpdateThumbnailProperties`. No `SetParent`, no cross-process ownership, no JPEG, no frame capture and no bitmap React rerendering.
- The source HWND is shown inactive within a 2-pixel monitor-edge strip to initialize its GPU surface, then parked completely offscreen after 1.6 seconds. Tested: a source created entirely offscreen stays white; one initialized on a tiny visible sliver renders after moving offscreen. This is a time-based initialization, not a reliable first-frame signal.
- T3 has its own browser-surface DOM rectangle. Pointer, wheel, keyboard, paste and composition events are forwarded via the authenticated input protocol. Pointer moves are coalesced to prevent IPC backlog; page rendering itself does not traverse IPC.
- A normal unmount unregisters only the DWM thumbnail. When T3 is forcibly terminated, Windows destroys its thumbnail registration but cannot destroy the independently owned host HWND or WebContentsView. The next T3 process registers a new thumbnail for the same UUID. T3 must never close the page simply because its UI disappears.
- T3 routes ordinary ChatGPT sessions exclusively to the v3 owner. Original Webviews remain selectable as a separate engine, not an image transport. The in-process native test slice remains separately scoped.

## Removed

- All JPEG frame polling/encoding and frame HTTP endpoints from the active host.
- React image rendering and deprecated `PersistentChatGPTSurface.tsx`.
- The unsafe cross-process `SetParent` path: forcibly killing its T3 parent also killed the detached Chromium owner, despite graceful-close tests passing.
- Browser fallback to an ephemeral in-process owner. Failures are reported instead of silently abandoning persistence.

## Verified independently

- DWM can show a live Electron `WebContentsView` inside another Electron window with no JPEG.
- A real ChatGPT document renders via DWM with its source HWND fully offscreen after initial edge painting.
- Force-killing the DWM destination leaves its independent source host PID unchanged with the page still resident.
- A source created fully offscreen without initial visible GPU painting yields blank white; edge-first initialization fixes this.
- Host accepts native attach and rejects frame requests.
- Typecheck of modified browser files is clean; workspace typechecking still has unrelated pre-existing errors.

## Production verification — November 2, 2026

- `pnpm build:desktop` succeeded with Node 24, and the production T3 window displayed the real contents of an existing ChatGPT conversation through DWM.
- A forced T3 termination and restart left the v3 host **PID 13764 unchanged** with **all five pre-existing session UUIDs resident**. The selected ChatGPT conversation visually reattached with its existing content.
- The host's native wheel input endpoint returned accepted and moved a real conversation scroller from `scrollTop=652` to `52`; its scroll position was restored. Renderer-level keyboard, paste, composition and pointer tests are still needed.
- Legacy v1/v2 hosts were stopped following user authorization to recreate pages. Session UUID/URL metadata was backed up locally in `.t3/worker-artifacts/pre-dwm-migration-sessions.json`; old unsent drafts were not transferred.
- Host rejects JPEG/frame endpoint calls; all user-visible native browser rendering is handled by DWM.
- Typechecking identified no new modified-file errors; the wider checkout still has unrelated existing type errors.

## Follow-up

- Verify keyboard, mouse targeting, clipboard, IME and focus through the real T3 renderer.
- Address tooltips, menu z-order, multi-monitor DPI and generic CDP automation parity.
- Replace the 1.6-second initial-paint heuristic with an explicit GPU first-frame readiness signal if slow starts produce white thumbnails.
- Preserve unrelated worktree modifications and never run the historical recovery-release deployment stage.

## Key files

- `scripts/persistent-chatgpt-offscreen-host.cjs` — independent Chromium owner
- `apps/desktop/src/preview/DetachedChatGPTNativeWindow.ts` — DWM registration/composition
- `apps/desktop/src/preview/PersistentChatGPTBrowser.ts` — authenticated host broker
- `apps/desktop/src/ipc/methods/stableChatGPTView.ts` — trusted lifecycle and presentation IPC
- `apps/web/src/browser/DetachedChatGPTSurface.tsx` — presentation geometry and input
- `apps/web/src/browser/DedicatedChatGPTBrowser.tsx` — T3 session browser UI
