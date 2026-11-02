// @effect-diagnostics globalTimers:off — native window z-order reconciliation is synchronous OS work.
// Native, unscaled ChatGPT pixels from a separate persistent Chromium process.
// We move and stack the independent HWND over T3's browser panel WITHOUT
// SetParent (which killed the host on hard T3 exit) and WITHOUT DWM thumbnails
// (which resampled text). Native pointer hit testing is transparent so T3's
// existing authenticated input forwarding remains the input owner.
import { BrowserWindow, screen } from "electron";
import { DataType, load, open } from "ffi-rs";

type Bounds = { x: number; y: number; width: number; height: number };
type Mounted = {
  owner: BrowserWindow;
  hwnd: number;
  hostPid: number;
  bounds: Bounds;
  exStyle: number;
  shown: boolean;
  suspended: boolean;
  onRendererGone: () => void;
  onBackground: () => void;
  lastGeometry: string;
  timer: ReturnType<typeof setInterval>;
  refresh: () => void;
  onHidden: () => void;
};
const sources = new Map<string, Mounted>();
const nativeLib = "t3-direct-chatgpt-overlay";
let opened = false;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_TOOLWINDOW = 0x80;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_HIDEWINDOW = 0x0080;

function native(
  name: string,
  types: DataType[],
  args: unknown[],
  retType: DataType = DataType.I32,
): number {
  if (!opened) {
    open({ library: nativeLib, path: "C:\\Windows\\System32\\user32.dll" });
    opened = true;
  }
  return Number(load({ library: nativeLib, funcName: name, paramsType: types, paramsValue: args, retType }));
}
function sourcePid(hwnd: number): number {
  const out = Buffer.alloc(4);
  native("GetWindowThreadProcessId", [DataType.U64, DataType.U8Array], [hwnd, out], DataType.U32);
  return out.readUInt32LE(0);
}
function show(hwnd: number, visible: boolean): void {
  if (!visible) {
    // A detached Chromium window must not remain permanently topmost after
    // leaving T3 or after a normal T3 shutdown.
    native(
      "SetWindowPos",
      [DataType.U64, DataType.I64, DataType.I32, DataType.I32, DataType.I32, DataType.I32, DataType.U32],
      [hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_HIDEWINDOW],
    );
    return;
  }
  native("ShowWindow", [DataType.U64, DataType.I32], [hwnd, SW_SHOWNOACTIVATE]);
}
function hideOrphanedVisibleHostWindows(current: number, hostPid: number, dest: Bounds): void {
  // After a forced T3 exit, its formerly presented independent HWNDs can
  // remain visible on the desktop. The next owner must clear those ghosts
  // before presenting the selected session. Never destroy their WebContents.
  let hwnd = native("GetTopWindow", [DataType.U64], [0], DataType.U64);
  for (let i = 0; hwnd && i < 1500; i++) {
    const next = native("GetWindow", [DataType.U64, DataType.U32], [hwnd, 2], DataType.U64);
    if (
      hwnd !== current &&
      sourcePid(hwnd) === hostPid &&
      native("IsWindowVisible", [DataType.U64], [hwnd])
    ) {
      const rect = Buffer.alloc(16);
      const valid = native("GetWindowRect", [DataType.U64, DataType.U8Array], [hwnd, rect]);
      if (valid) {
        const left = rect.readInt32LE(0), top = rect.readInt32LE(4);
        const right = rect.readInt32LE(8), bottom = rect.readInt32LE(12);
        if (
          right > dest.x && left < dest.x + dest.width &&
          bottom > dest.y && top < dest.y + dest.height
        ) show(hwnd, false);
      }
    }
    hwnd = next;
  }
}
function t3OwnsForeground(owner: BrowserWindow): boolean {
  const foreground = native("GetForegroundWindow", [], [], DataType.U64);
  // Native popovers and tooltips may be focused while the parent BrowserWindow
  // reports isFocused() false. Foreground PID is the reliable test for T3.
  return (foreground !== 0 && sourcePid(foreground) === process.pid) ||
    (foreground === 0 && owner.isFocused());
}
function toScreen(owner: BrowserWindow, rect: Bounds): Bounds {
  // Renderer geometry is in DIP relative to the window content; Electron
  // converts to monitor-specific physical coordinates. No scaling is applied
  // to browser pixels: host WebContentsView and overlay use the same DIP size.
  const c = owner.getContentBounds();
  return screen.dipToScreenRect(owner, {
    x: Math.round(c.x + rect.x),
    y: Math.round(c.y + rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}
function removeListeners(entry: Mounted): void {
  entry.owner.removeListener("focus", entry.refresh);
  entry.owner.removeListener("show", entry.refresh);
  entry.owner.removeListener("restore", entry.refresh);
  entry.owner.removeListener("move", entry.refresh);
  entry.owner.removeListener("resize", entry.refresh);
  entry.owner.removeListener("blur", entry.onBackground);
  entry.owner.removeListener("hide", entry.onHidden);
  entry.owner.removeListener("minimize", entry.onHidden);
  if (!entry.owner.webContents.isDestroyed()) {
    entry.owner.webContents.removeListener("render-process-gone", entry.onRendererGone);
    // Restore T3's usual occlusion policy only after the independent native
    // window no longer covers any of its renderer's pixels.
    entry.owner.webContents.setBackgroundThrottling(true);
  }
}
export function hideDirectChatGPTOverlay(sessionId: string): void {
  const entry = sources.get(sessionId);
  if (!entry) return;
  sources.delete(sessionId);
  clearInterval(entry.timer);
  removeListeners(entry);
  if (sourcePid(entry.hwnd) !== entry.hostPid) return;
  show(entry.hwnd, false);
}
export function showDirectChatGPTOverlay(input: {
  sessionId: string;
  owner: BrowserWindow;
  sourceHwnd: string;
  hostPid: number;
  bounds: Bounds;
}): { display: "native"; visible: true } {
  if (process.platform !== "win32") throw new Error("Direct Chromium overlay requires Windows");
  const { sessionId, owner, sourceHwnd, hostPid, bounds } = input;
  if (
    !/^[0-9]{1,16}$/.test(sourceHwnd) ||
    !Number.isSafeInteger(hostPid) ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width < 1 || bounds.height < 1 || bounds.width > 8192 || bounds.height > 4320
  ) throw new Error("Invalid direct Chromium overlay coordinates");
  const hwnd = Number(sourceHwnd);
  if (!Number.isSafeInteger(hwnd) || sourcePid(hwnd) !== hostPid)
    throw new Error("Detached Chromium source HWND no longer matches its host");
  for (const [id, item] of sources) {
    if (id !== sessionId && item.owner === owner) hideDirectChatGPTOverlay(id);
  }
  let entry = sources.get(sessionId);
  if (entry && (entry.owner !== owner || entry.hwnd !== hwnd)) {
    hideDirectChatGPTOverlay(sessionId);
    entry = undefined;
  }
  if (entry) {
    entry.bounds = bounds;
    // Only a fresh presentation from the recovered renderer may resume a
    // window suspended because the previous renderer disappeared.
    entry.suspended = false;
    entry.refresh();
    return { display: "native", visible: true };
  }

  const original = native("GetWindowLongW", [DataType.U64, DataType.I32], [hwnd, -20]);
  const exStyle = original | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
  native("SetWindowLongW", [DataType.U64, DataType.I32, DataType.I32], [hwnd, -20, exStyle]);
  const onHidden = () => {
    const item = sources.get(sessionId);
    if (item) item.shown = false;
    if (sourcePid(hwnd) === hostPid) show(hwnd, false);
  };
  const onBackground = () => {
    const item = sources.get(sessionId);
    if (!item || sourcePid(hwnd) !== hostPid || !item.shown) return;
    item.shown = false;
    // Alt-Tab must NOT hide Chromium's HWND or tell the host to throttle the
    // selected page. Hiding stopped GPU painting and it sometimes came back
    // white. Demote it instead, leaving its real native surface alive.
    native(
      "SetWindowPos",
      [DataType.U64, DataType.I64, DataType.I32, DataType.I32, DataType.I32, DataType.I32, DataType.U32],
      [hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE],
    );
    // Put the newly foreground app above Chromium rather than having the
    // still-visible ChatGPT page float over whichever app received Alt-Tab.
    const foreground = native("GetForegroundWindow", [], [], DataType.U64);
    if (foreground && foreground !== hwnd && sourcePid(foreground) !== hostPid) {
      native(
        "SetWindowPos",
        [DataType.U64, DataType.U64, DataType.I32, DataType.I32, DataType.I32, DataType.I32, DataType.U32],
        [hwnd, foreground, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE],
      );
    }
  };
  const onRendererGone = () => {
    const item = sources.get(sessionId);
    if (item) item.suspended = true;
    // Keep the ChatGPT page alive in its host, but stop drawing the native
    // overlay until T3's replacement renderer positively reattaches it.
    onHidden();
  };
  const refresh = () => {
    const item = sources.get(sessionId);
    if (!item || owner.isDestroyed() || sourcePid(hwnd) !== hostPid || item.suspended) return;
    if (!owner.isVisible() || owner.isMinimized()) {
      if (item.shown || native("IsWindowVisible", [DataType.U64], [hwnd])) onHidden();
      return;
    }
    if (!t3OwnsForeground(owner)) {
      onBackground();
      return;
    }
    const dest = toScreen(owner, item.bounds);
    const geometry = `${dest.x},${dest.y},${dest.width},${dest.height}`;
    // Chromium's top-level HWND MUST be above T3's Chromium-independent main
    // window. HWND_TOP was silently pushed behind T3 on activation, leaving a
    // black browser pane despite the live ChatGPT DOM remaining resident.
    // Do not raise it every 200ms: that repeatedly obscures native tooltip
    // windows and creates extra desktop-compositor work.
    if (item.shown && item.lastGeometry === geometry &&
        native("IsWindowVisible", [DataType.U64], [hwnd])) return;
    hideOrphanedVisibleHostWindows(hwnd, hostPid, dest);
    const ok = native(
      "SetWindowPos",
      [DataType.U64, DataType.I64, DataType.I32, DataType.I32, DataType.I32, DataType.I32, DataType.U32],
      [hwnd, HWND_TOPMOST, dest.x, dest.y, dest.width, dest.height, SWP_NOACTIVATE | SWP_SHOWWINDOW],
    );
    if (!ok) { onHidden(); return; }
    item.shown = true;
    item.lastGeometry = geometry;
  };
  entry = {
    owner, hwnd, hostPid, bounds, exStyle, shown: false, suspended: false,
    lastGeometry: "", refresh, onHidden, onBackground, onRendererGone,
    // Lightweight visibility/focus reconciliation; no repeated window raises,
    // screenshot polling, browser reloads or Chromium IPC traffic.
    timer: setInterval(refresh, 400),
  };
  sources.set(sessionId, entry);
  // An always-on-top native Chromium window can make Chromium classify the
  // underlying T3 renderer as fully occluded, leaving the app black while the
  // independent ChatGPT page remains visible. Keep T3's renderer painting
  // whenever one of these windows is mounted over it.
  owner.webContents.setBackgroundThrottling(false);
  owner.webContents.on("render-process-gone", onRendererGone);
  owner.on("focus", refresh);
  owner.on("show", refresh);
  owner.on("restore", refresh);
  owner.on("move", refresh);
  owner.on("resize", refresh);
  owner.on("blur", onBackground);
  owner.on("hide", onHidden);
  owner.on("minimize", onHidden);
  owner.once("closed", () => hideDirectChatGPTOverlay(sessionId));
  refresh();
  return { display: "native", visible: true };
}
