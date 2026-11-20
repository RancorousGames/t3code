/**
 * Manage Windows main-window activation and renderer reloads.
 * Closing the main window exits T3, including its embedded ChatGPT webviews;
 * a new launch recreates them. A second launch focuses the existing window.
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

  // Handle a second executable launch synchronously, ahead of the
  // asynchronous desktop/Clerk activation pipeline. This also repairs any
  // older hidden window left behind by a prior build.
  app.on("second-instance", () => {
    if (quitting || !primaryWindow || primaryWindow.isDestroyed()) return;
    if (!primaryWindow.isVisible()) primaryWindow.show();
    if (primaryWindow.isMinimized()) primaryWindow.restore();
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
      if (primaryWindow !== window) return;
      primaryWindow = null;
      // Hidden Electron utility windows must not keep T3 running after its main window closes.
      if (!quitting) app.quit();
    });
  });
}
