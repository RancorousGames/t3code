/**
 * Keep the *real* T3 BrowserWindow and its native ChatGPT WebContentsViews alive
 * when the user closes the visible desktop window.
 *
 * Electron's existing Clerk single-instance lock then makes an ordinary
 * second launch of T3 Code (Custom).exe reveal this same owner; no alternate
 * launcher, demo window, or special flag is needed.
 *
 * App.quit(), updater-controlled quit, and explicit process shutdown still
 * destroy the owner. Closing/hiding is intentionally distinct from Quit.
 */
import type { App, BrowserWindow } from "electron";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Synchronous main-process acknowledgement for Win32 native reload.
import * as Fs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - This path is owned by the stable Electron process.
import * as Path from "node:path";

const DESKTOP_SCHEMES = new Set(["t3code:", "t3code-dev:"]);
// Explicit Windows message to reload ONLY the T3 renderer, never a guest.
// Python's build helper requires a matching nonce acknowledgement.
const UI_RELOAD_MESSAGE = 0x8000 + 0x236;
const UI_RELOAD_MAGIC = 0x5433524c;

function isT3RendererURL(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return DESKTOP_SCHEMES.has(url.protocol) && url.hostname === "app";
  } catch {
    return false;
  }
}

export function installPersistentMainWindowLifecycle(app: App): void {
  if (process.platform !== "win32") return;

  let quitting = false;
  let primaryWindow: BrowserWindow | null = null;
  app.on("before-quit", () => {
    quitting = true;
  });

  // Handle a normal second executable launch synchronously, ahead of the
  // asynchronous desktop/Clerk activation pipeline. A hidden persistent owner
  // is still alive but has no visible taskbar window; showing it must not
  // depend on a backend handshake or an Effect service remembering the HWND.
  app.on("second-instance", () => {
    if (quitting || !primaryWindow || primaryWindow.isDestroyed()) return;
    if (primaryWindow.isMinimized()) primaryWindow.restore();
    if (!primaryWindow.isVisible()) primaryWindow.show();
    primaryWindow.focus();
  });

  app.on("browser-window-created", (_event, window: BrowserWindow) => {
    let primaryT3Window = false;
    const markT3Window = () => {
      if (!window.isDestroyed() && isT3RendererURL(window.webContents.getURL())) {
        primaryT3Window = true;
        primaryWindow = window;
      }
    };
    window.webContents.on("did-finish-load", markT3Window);
    window.webContents.on("did-navigate", markT3Window);

    window.hookWindowMessage(UI_RELOAD_MESSAGE, (wParam, lParam) => {
      if (quitting || !primaryT3Window || window.isDestroyed()) return;
      if (wParam.readUInt32LE(0) !== UI_RELOAD_MAGIC) return;
      const nonce = lParam.readUInt32LE(0);
      if (nonce === 0) return;
      const webContents = window.webContents;
      const wasVisible = window.isVisible();
      if (wasVisible) window.hide();
      const restore = () => {
        clearTimeout(restoreTimeout);
        if (wasVisible && !window.isDestroyed()) window.show();
      };
      // A failed UI reload must never leave the actual window hidden.
      const restoreTimeout = setTimeout(restore, 15_000);
      const acknowledge = () => {
        restore();
        if (window.isDestroyed() || webContents.isDestroyed()) return;
        if (!isT3RendererURL(webContents.getURL())) return;
        const root = process.env.T3CODE_HOME;
        if (!root) return;
        // A fresh matching ack is required. This cannot be mistaken for an
        // old successful command, and doesn't expose any guest page data.
        try {
          const filename = Path.join(root, "native-ui-reload-ack.json");
          Fs.writeFileSync(
            filename,
            JSON.stringify({
              pid: process.pid,
              nonce,
              url: webContents.getURL(),
            }),
          );
        } catch {
          // A missing acknowledgement causes the caller to fail closed.
        }
      };
      webContents.once("did-finish-load", acknowledge);
      try {
        webContents.reload();
      } catch (error) {
        webContents.removeListener("did-finish-load", acknowledge);
        restore();
        throw error;
      }
    });

    window.on("closed", () => {
      if (primaryWindow === window) primaryWindow = null;
    });

    window.on("close", (event) => {
      // Do not intercept popups, WSL connecting splashes, updater shutdown,
      // explicit Quit, or windows that never loaded the real T3 interface.
      if (quitting || !primaryT3Window || window.isDestroyed()) return;
      event.preventDefault();
      window.hide();
    });
  });
}
