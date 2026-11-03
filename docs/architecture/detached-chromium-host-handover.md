# T3 persistent Chromium — owned windows

**Goal:** ChatGPT pages inside T3 that feel like a normal browser and survive T3 rebuilds, restarts and crashes.

## The design

- A separate host process (`scripts/persistent-chatgpt-offscreen-host.cjs`) owns every page, each in its own chrome-less top-level window.
- T3 makes the visible page's window a Win32 **owned window** of T3's main window and positions it over the browser pane (`apps/desktop/src/preview/DirectChatGPTOverlay.ts`).
- Windows does the rest. It keeps the page above T3, hides it when T3 minimizes, and handles Alt-Tab. Mouse, keyboard, IME, clipboard and drag-and-drop go straight to the page.

## Why not the alternatives

| Approach                             | Why it was dropped                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-process pages                     | Die with T3.                                                                                                                                                                                                                        |
| JPEG frames                          | Slow and blurry.                                                                                                                                                                                                                    |
| `SetParent` / `WS_CHILD`             | Force-killing T3 destroys the child window and Electron crashes natively, taking every page with it. There is no JavaScript callback to recover in. See [the investigation](native-chromium-embedding-investigation-2026-11-02.md). |
| DWM thumbnails                       | Resampled text and needed all input relayed.                                                                                                                                                                                        |
| Free-floating `HWND_TOPMOST` overlay | Needed polling and focus tracking to fake stacking, and every input event took a trip through T3's renderer, main process and a pipe. This was the lag, and the source of the Alt-Tab and z-order bugs.                             |

An owned window is not clipped to T3 the way a child is. That does not matter here because the pane is always inside T3. It also trails T3 very slightly during a window drag.

## Rules that are easy to break

- **Never relay input to the page.** `/sessions/input` exists only for agent automation.
- **Only the host shows or hides a page window.** A window shown from outside stays "hidden" to Chromium and does not paint.
- **Only the host sizes a page window.** Chromium pins a non-resizable window's size against outside changes. It must stay non-resizable, or the page grows resize handles along its edges. T3 resends the size when the monitor scale changes, because pixel size depends on it.
- **Toasts never hide the page.** A page hides while a real menu or modal overlaps it, but toasts are also `role="dialog"` and must be excluded, or any notification blanks every session.
- **T3 sets position only**, with `SWP_ASYNCWINDOWPOS` so its main thread never blocks on the host.
- **Keep Chromium's background throttling on for hidden pages.** Only the visible page opts out, or dozens of retained pages use real CPU.

## Host and T3 talking to each other

- T3 holds a `GET /events` stream open to the host. It carries shortcuts (T3 no longer sees the page's keys), Alt+F4 and a throttled "user is active" signal.
- The same stream is how the host learns T3 died: the pipe closes even on a forced kill. The host then hides the visible page, which Windows would otherwise leave floating on the desktop.
- Ctrl+W, Ctrl+F and F2 belong to T3. Other shortcuts reach both T3 and the page, so ChatGPT's own keys keep working. AltGr text is never treated as a shortcut.

## Updating the host

The host outlives T3, so it keeps running old code after a rebuild. When T3 and the host must change together, bump `HOST_PROTOCOL` in both the host script and `apps/desktop/src/preview/PersistentChatGPTBrowser.ts`. A T3 that finds a different version shuts the old host down and starts a new one. Pages then reload from their URLs and lose unsent drafts, so bump only when necessary.
