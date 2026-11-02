// GPU-composited native Chromium view without cross-process HWND parenting.
// DWM thumbnails render the detached owner's real Chromium surface into T3.
// The source remains a separate top-level HWND, so abruptly terminating T3
// cannot destroy the source window or its living WebContentsView.
import { BrowserWindow } from "electron";
import { DataType, open, load } from "ffi-rs";

type Bounds = { x: number; y: number; width: number; height: number };
type Surface = { owner: BrowserWindow; hwnd: number; sourcePid: number; thumbnail: number };
const surfaces = new Map<string, Surface>();
const dwmLibrary = "t3-chatgpt-dwm";
const win32Library = "t3-chatgpt-win32";
let initialized = false;
function begin(): void {
  if (initialized) return;
  open({ library: dwmLibrary, path: "C:\\Windows\\System32\\dwmapi.dll" });
  open({ library: win32Library, path: "C:\\Windows\\System32\\user32.dll" });
  initialized = true;
}
function call(library: string, name: string, types: DataType[], args: unknown[], ret: DataType = DataType.I32): number {
  return Number(load({ library, funcName: name, paramsType: types, paramsValue: args, retType: ret }));
}
function sourceProcessId(hwnd: number): number {
  const pid = Buffer.alloc(4);
  call(win32Library, "GetWindowThreadProcessId", [DataType.U64, DataType.U8Array], [hwnd, pid], DataType.U32);
  return pid.readUInt32LE(0);
}
export function unmountPersistentChatGPTWindow(sessionId: string): void {
  const surface = surfaces.get(sessionId);
  if (!surface) return;
  surfaces.delete(sessionId);
  try {
    call(dwmLibrary, "DwmUnregisterThumbnail", [DataType.U64], [surface.thumbnail]);
  } catch {
    // The DWM registration also disappears automatically when T3 exits.
  }
}
export function mountPersistentChatGPTWindow(input: {
  sessionId: string;
  owner: BrowserWindow;
  sourceHwnd: string;
  hostPid: number;
  bounds: Bounds;
}): { display: "native"; visible: true } {
  if (process.platform !== "win32") throw new Error("GPU-composited Chromium requires Windows DWM");
  const { sessionId, owner, sourceHwnd, hostPid, bounds } = input;
  if (
    !/^[0-9]{1,16}$/.test(sourceHwnd) ||
    !Number.isSafeInteger(hostPid) ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width < 1 || bounds.height < 1 || bounds.width > 2560 || bounds.height > 1600
  ) throw new Error("Invalid native Chromium presentation geometry");
  begin();
  const hwnd = Number(sourceHwnd);
  if (!Number.isSafeInteger(hwnd) || sourceProcessId(hwnd) !== hostPid)
    throw new Error("ChatGPT compositor source HWND no longer belongs to the authenticated host");
  const destination = Number(owner.getNativeWindowHandle().readBigUInt64LE(0));
  let surface = surfaces.get(sessionId);
  if (surface && (surface.hwnd !== hwnd || surface.owner !== owner)) {
    unmountPersistentChatGPTWindow(sessionId);
    surface = undefined;
  }
  if (!surface) {
    const handleOut = Buffer.alloc(8);
    const result = call(
      dwmLibrary, "DwmRegisterThumbnail",
      [DataType.U64, DataType.U64, DataType.U8Array],
      [destination, hwnd, handleOut],
    );
    if (result !== 0) throw new Error(`DWM native surface registration failed (HRESULT ${result})`);
    surface = { owner, hwnd, sourcePid: hostPid, thumbnail: Number(handleOut.readBigUInt64LE(0)) };
    surfaces.set(sessionId, surface);
    owner.once("closed", () => unmountPersistentChatGPTWindow(sessionId));
  }
  // DWM_THUMBNAIL_PROPERTIES: dwFlags, RECT dest, RECT source, opacity,
  // BOOL fVisible, BOOL fSourceClientAreaOnly. Do not copy any frame data.
  const properties = Buffer.alloc(48);
  properties.writeUInt32LE(0x01 | 0x04 | 0x08 | 0x10, 0);
  properties.writeInt32LE(Math.round(bounds.x), 4);
  properties.writeInt32LE(Math.round(bounds.y), 8);
  properties.writeInt32LE(Math.round(bounds.x + bounds.width), 12);
  properties.writeInt32LE(Math.round(bounds.y + bounds.height), 16);
  properties.writeUInt8(255, 36);
  properties.writeInt32LE(1, 40);
  properties.writeInt32LE(1, 44);
  const result = call(
    dwmLibrary, "DwmUpdateThumbnailProperties",
    [DataType.U64, DataType.U8Array],
    [surface.thumbnail, properties],
  );
  if (result !== 0) {
    unmountPersistentChatGPTWindow(sessionId);
    throw new Error(`DWM native surface update failed (HRESULT ${result})`);
  }
  return { display: "native", visible: true };
}
