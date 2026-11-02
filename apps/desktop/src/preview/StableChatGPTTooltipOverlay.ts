/** Noninteractive native hovercard surface above Electron WebContentsView.
 * A child BrowserWindow follows its owner and is in the native z-order,
 * unlike HTML tooltips rendered in the T3 UI renderer below the Chrome view.
 * The underlying ChatGPT view is NEVER hidden, moved or reloaded.
 */
import { BrowserWindow, type Rectangle } from "electron";

const MAX_TOOLTIP_HTML = 110_000;
const MAX_TOOLTIP_WIDTH = 1000;
const MAX_TOOLTIP_HEIGHT = 1400;

const DOCUMENT = `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">
<style>html,body{margin:0!important;padding:0!important;overflow:hidden;background:transparent!important}
#tooltip{display:block;width:100%;height:100%;overflow:hidden} *{box-sizing:border-box}</style>
</head><body><div id="tooltip"></div></body></html>`;

export function createStableChatGPTTooltipOverlay(owner: BrowserWindow) {
  let popup: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  let latestBounds: Rectangle | null = null;
  let lastHtml = "";
  let generation = 0;
  let destroyed = false;
  let activeSessionId: string | null = null;

  const hide = (sessionId?: string) => {
    // A late unmount from session A must not hide session B's hovercard.
    if (typeof sessionId === "string" && activeSessionId !== sessionId) return;
    generation++;
    activeSessionId = null;
    latestBounds = null;
    if (popup && !popup.isDestroyed()) popup.hide();
  };

  const move = () => {
    if (!latestBounds || !popup || popup.isDestroyed() || owner.isDestroyed()) return;
    const content = owner.getContentBounds();
    popup.setBounds({
      x: content.x + latestBounds.x,
      y: content.y + latestBounds.y,
      width: latestBounds.width,
      height: latestBounds.height,
    });
  };

  const ensure = async () => {
    if (popup && !popup.isDestroyed() && ready) {
      await ready;
      return popup;
    }
    const window = new BrowserWindow({
      parent: owner,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      width: 1,
      height: 1,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    popup = window;
    ready = window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(DOCUMENT));
    await ready;
    return window;
  };

  const show = async (sessionId: string, bounds: Rectangle, html: string) => {
    if (destroyed || owner.isDestroyed()) return;
    if (
      html.length > MAX_TOOLTIP_HTML ||
      !html ||
      !Number.isSafeInteger(bounds.x) ||
      !Number.isSafeInteger(bounds.y) ||
      !Number.isSafeInteger(bounds.width) ||
      !Number.isSafeInteger(bounds.height) ||
      bounds.width < 1 ||
      bounds.height < 1 ||
      bounds.width > MAX_TOOLTIP_WIDTH ||
      bounds.height > MAX_TOOLTIP_HEIGHT
    )
      throw new Error("Invalid native tooltip geometry or content.");
    const current = ++generation;
    activeSessionId = sessionId;
    const window = await ensure();
    if (destroyed || current !== generation || window.isDestroyed()) return;
    const documentChanged = html !== lastHtml;
    if (documentChanged) {
      // Text was escaped in the T3 renderer's cloned DOM. No application
      // scripts or remote resources are available in this isolated popup.
      await window.webContents.executeJavaScript(
        `document.getElementById("tooltip").innerHTML = ${JSON.stringify(html)}`,
        false,
      );
      if (destroyed || current !== generation || window.isDestroyed()) return;
      lastHtml = html;
    }
    latestBounds = bounds;
    move();
    // Direct, independent Chromium HWNDs sit above the T3 main window.
    // Keep this small non-interactive hovercard above those native pixels,
    // while the existing owner blur handler hides it with T3.
    window.setAlwaysOnTop(true, "floating");
    window.showInactive();
  };

  owner.on("move", move);
  owner.on("resize", move);
  owner.on("hide", hide);
  owner.on("blur", hide);
  owner.webContents.on("did-start-navigation", hide);
  owner.on("closed", () => {
    destroyed = true;
    hide();
    if (popup && !popup.isDestroyed()) popup.destroy();
  });
  return { show, hide } as const;
}
