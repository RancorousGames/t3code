import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, it, vi } from "vite-plus/test";
import { hideDirectChatGPTOverlay, showDirectChatGPTOverlay } from "./DirectChatGPTOverlay.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn(async () => ({})) }));
vi.mock("./PersistentChatGPTBrowser.ts", () => ({
  onPersistentChatGPTHostEvent() {},
  persistentChatGPTRequest: mocks.request,
}));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: {
    dipToScreenRect: (_owner: unknown, bounds: unknown) => bounds,
    getDisplayMatching: () => ({ scaleFactor: 1 }),
  },
}));
vi.mock("ffi-rs", () => ({
  DataType: {},
  open() {},
  load: ({ funcName, paramsValue }: { funcName: string; paramsValue: unknown[] }) => {
    if (funcName === "GetWindowThreadProcessId") (paramsValue[1] as Buffer).writeUInt32LE(123);
    return 0;
  },
}));

it("releases each overlay's owner listeners and stops rendering while minimized", async () => {
  mocks.request.mockClear();
  using _platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setBackgroundThrottling: vi.fn(),
  });
  let minimized = false;
  const owner = Object.assign(new EventEmitter(), {
    webContents: contents,
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    getContentBounds: () => ({ x: 0, y: 0 }),
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => minimized,
  });
  const input = {
    sessionId: "11111111-1111-1111-1111-111111111111",
    owner: owner as unknown as BrowserWindow,
    sourceHwnd: "2",
    hostPid: 123,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  try {
    for (let i = 0; i < 20; i++) {
      showDirectChatGPTOverlay(input);
      hideDirectChatGPTOverlay(input.sessionId);
      expect(owner.eventNames()).toEqual([]);
      expect(contents.eventNames()).toEqual([]);
    }
    showDirectChatGPTOverlay(input);
    minimized = true;
    owner.emit("minimize");
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith({
      operation: "visibility", sessionId: input.sessionId, visible: false,
    }));
    minimized = false;
    owner.emit("restore");
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith({
      operation: "visibility", sessionId: input.sessionId, visible: true,
    }));
  } finally {
    hideDirectChatGPTOverlay(input.sessionId);
  }
});
