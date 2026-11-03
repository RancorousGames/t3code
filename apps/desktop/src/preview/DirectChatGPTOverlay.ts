// Presents a page from the persistent Chromium host over T3's browser pane by
// making its window a Win32 *owned* window of T3. Windows then handles stacking,
// Alt-Tab, minimize and direct input for us, which is why there is no z-order
// polling, focus tracking or input relay here.
//
// Do not "upgrade" this to SetParent/WS_CHILD: when a child's parent process is
// force-killed, Windows destroys the child and Electron crashes natively, taking
// every page with it. An owned window just loses its owner and can be re-adopted.
// See docs/architecture/detached-chromium-host-handover.md.
import { BrowserWindow, screen } from "electron";
import { DataType, load, open } from "ffi-rs";

import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";
import {
  dispatchChatGPTGuestKeyToOwner,
  FIND_CHATGPT_MENU_ACTION,
  nativeChatGPTGuestShortcut,
} from "./NativeChatGPTGuestShortcut.ts";
import { RENAME_CHATGPT_SESSION_MENU_ACTION } from "../window/ChatGPTCloseShortcut.ts";
import {
  onPersistentChatGPTHostEvent,
  persistentChatGPTRequest,
  type PersistentChatGPTHostEvent,
  type PersistentChatGPTRequest,
} from "./PersistentChatGPTBrowser.ts";

type Bounds = { x: number; y: number; width: number; height: number };
type Mounted = {
  owner: BrowserWindow;
  hwnd: number;
  hostPid: number;
  bounds: Bounds;
  // Size and display scale last sent to the host, screen position last set, and
  // whether the window was last sent "show".
  sizedAs: string;
  placedAt: string;
  shown: boolean;
  // Set when T3's renderer dies: stay hidden until its replacement presents.
  suspended: boolean;
  place: () => void;
  conceal: () => void;
  onRendererGone: () => void;
};
const sources = new Map<string, Mounted>();
const nativeLib = "t3-direct-chatgpt-overlay";
let opened = false;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const GW_HWNDPREV = 3;
const WS_EX_TOOLWINDOW = 0x80;
const HWND_TOP = 0;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
// Queue the change on the host's thread. T3's main thread must never block on
// another process, and T3 must keep working if the host is momentarily busy.
const SWP_ASYNCWINDOWPOS = 0x4000;

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
  return Number(
    load({ library: nativeLib, funcName: name, paramsType: types, paramsValue: args, retType }),
  );
}
function setWindowPos(hwnd: number, after: number, x: number, y: number, flags: number): void {
  native(
    "SetWindowPos",
    [
      DataType.U64,
      DataType.U64,
      DataType.I32,
      DataType.I32,
      DataType.I32,
      DataType.I32,
      DataType.U32,
    ],
    [hwnd, after, x, y, 0, 0, flags | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS],
  );
}
// Only the host may size, show or hide its window (see createDurableNativePage).
// In order, so a quick show then hide cannot arrive reversed on separate connections.
let hostChain: Promise<unknown> = Promise.resolve();
function sendToHost(input: PersistentChatGPTRequest): void {
  hostChain = hostChain.then(() => persistentChatGPTRequest(input)).catch(() => undefined);
}
function setHostVisible(sessionId: string, visible: boolean): void {
  sendToHost({ operation: "visibility", sessionId, visible });
}
function sourcePid(hwnd: number): number {
  const out = Buffer.alloc(4);
  native("GetWindowThreadProcessId", [DataType.U64, DataType.U8Array], [hwnd, out], DataType.U32);
  return out.readUInt32LE(0);
}
/** Renderer geometry is in DIP relative to the window content; this makes it
 * relative to the desktop, which is also the form Electron's setBounds takes. */
function toDesktopDip(owner: BrowserWindow, rect: Bounds): Bounds {
  const c = owner.getContentBounds();
  return {
    x: Math.round(c.x + rect.x),
    y: Math.round(c.y + rect.y),
    width: Math.min(8192, Math.round(rect.width)),
    height: Math.min(4320, Math.round(rect.height)),
  };
}

/** Host events only concern the page on screen, so route them to its T3 window. */
function handleHostEvent(event: PersistentChatGPTHostEvent): void {
  const owner = sources.get(event.sessionId)?.owner;
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return;
  if (event.type === "close-requested") {
    owner.close();
    return;
  }
  if (event.type === "interaction") {
    void owner.webContents
      .executeJavaScript(`window.dispatchEvent(new Event("t3:chatgpt-page-interaction"))`, false)
      .catch(() => undefined);
    return;
  }
  const action = nativeChatGPTGuestShortcut(
    event.input,
    process.platform,
    owner.webContents.getURL(),
    event.sessionId,
  );
  if (!action) {
    dispatchChatGPTGuestKeyToOwner(owner, event.input);
    return;
  }
  // These two open T3 inputs, which need keyboard focus back from the page.
  if (action === FIND_CHATGPT_MENU_ACTION || action === RENAME_CHATGPT_SESSION_MENU_ACTION)
    owner.focus();
  if (!event.input.isAutoRepeat) owner.webContents.send(MENU_ACTION_CHANNEL, action);
}
onPersistentChatGPTHostEvent(handleHostEvent);

function removeListeners(entry: Mounted): void {
  entry.owner.removeListener("move", entry.place);
  entry.owner.removeListener("resize", entry.place);
  entry.owner.removeListener("restore", entry.place);
  entry.owner.removeListener("show", entry.place);
  // Minimize needs nothing: Windows hides owned windows with their owner.
  entry.owner.removeListener("hide", entry.conceal);
  if (!entry.owner.webContents.isDestroyed()) {
    entry.owner.webContents.removeListener("render-process-gone", entry.onRendererGone);
    entry.owner.webContents.setBackgroundThrottling(true);
  }
}
export function hideDirectChatGPTOverlay(sessionId: string): void {
  const entry = sources.get(sessionId);
  if (!entry) return;
  sources.delete(sessionId);
  removeListeners(entry);
  if (sourcePid(entry.hwnd) === entry.hostPid) entry.conceal();
}

/** Fast path for a page already on screen: reposition without any host request.
 * Returns false when the page must go through a full showDirectChatGPTOverlay. */
export function updateDirectChatGPTOverlay(
  sessionId: string,
  owner: BrowserWindow,
  bounds: Bounds,
): boolean {
  const entry = sources.get(sessionId);
  if (!entry || entry.owner !== owner || sourcePid(entry.hwnd) !== entry.hostPid) return false;
  entry.bounds = bounds;
  // Only a fresh presentation from the recovered renderer may resume a window
  // suspended because the previous renderer disappeared.
  entry.suspended = false;
  entry.place();
  return true;
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
    bounds.width < 1 ||
    bounds.height < 1 ||
    bounds.width > 8192 ||
    bounds.height > 4320
  )
    throw new Error("Invalid direct Chromium overlay coordinates");
  const hwnd = Number(sourceHwnd);
  if (!Number.isSafeInteger(hwnd) || sourcePid(hwnd) !== hostPid)
    throw new Error("Detached Chromium source HWND no longer matches its host");
  for (const [id, item] of sources) {
    if (id !== sessionId && item.owner === owner) hideDirectChatGPTOverlay(id);
  }
  hideDirectChatGPTOverlay(sessionId);

  const ownerHwnd = Number(owner.getNativeWindowHandle().readBigUInt64LE(0));
  native(
    "SetWindowLongPtrW",
    [DataType.U64, DataType.I32, DataType.U64],
    [hwnd, GWLP_HWNDPARENT, ownerHwnd],
  );
  // Keeps the page out of Alt-Tab while it is briefly ownerless during a restart.
  const exStyle = native("GetWindowLongW", [DataType.U64, DataType.I32], [hwnd, GWL_EXSTYLE]);
  native(
    "SetWindowLongW",
    [DataType.U64, DataType.I32, DataType.I32],
    [hwnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW],
  );

  const conceal = () => {
    const item = sources.get(sessionId);
    if (item) item.shown = false;
    setHostVisible(sessionId, false);
  };
  const onRendererGone = () => {
    const item = sources.get(sessionId);
    if (item) item.suspended = true;
    conceal();
  };
  const place = () => {
    const item = sources.get(sessionId);
    if (!item || item.suspended || owner.isDestroyed()) return;
    if (!owner.isVisible() || owner.isMinimized()) return;
    if (sourcePid(hwnd) !== hostPid) return;
    const dip = toDesktopDip(owner, item.bounds);
    const dest = screen.dipToScreenRect(owner, dip);
    // Pixel size depends on the monitor's scale, so crossing to another monitor
    // needs a new size even when the pane's DIP size is unchanged. Dragging on
    // one monitor changes neither, so it costs no pipe traffic.
    const sizedAs = `${dip.width}x${dip.height}@${screen.getDisplayMatching(dip).scaleFactor}`;
    if (item.sizedAs !== sizedAs) {
      item.sizedAs = sizedAs;
      sendToHost({ operation: "resize", sessionId, ...dip });
    }
    const placedAt = `${dest.x},${dest.y}`;
    if (item.shown && item.placedAt === placedAt) return;
    if (item.shown) {
      setWindowPos(hwnd, 0, dest.x, dest.y, SWP_NOZORDER);
    } else {
      // Slot in directly above T3, so a page shown while another app covers T3
      // appears under that app rather than jumping in front of it.
      const above = native(
        "GetWindow",
        [DataType.U64, DataType.U32],
        [ownerHwnd, GW_HWNDPREV],
        DataType.U64,
      );
      setWindowPos(hwnd, above === hwnd ? HWND_TOP : above || HWND_TOP, dest.x, dest.y, 0);
      setHostVisible(sessionId, true);
    }
    item.shown = true;
    item.placedAt = placedAt;
  };
  const entry: Mounted = {
    owner,
    hwnd,
    hostPid,
    bounds,
    sizedAs: "",
    placedAt: "",
    shown: false,
    suspended: false,
    place,
    conceal,
    onRendererGone,
  };
  sources.set(sessionId, entry);
  // A foreign window over T3 can make Chromium classify T3's renderer as fully
  // occluded and stop painting it. Keep T3 painting while a page is mounted.
  owner.webContents.setBackgroundThrottling(false);
  owner.webContents.on("render-process-gone", onRendererGone);
  owner.on("move", place);
  owner.on("resize", place);
  owner.on("restore", place);
  owner.on("show", place);
  owner.on("hide", conceal);
  owner.once("closed", () => hideDirectChatGPTOverlay(sessionId));
  place();
  return { display: "native", visible: true };
}
