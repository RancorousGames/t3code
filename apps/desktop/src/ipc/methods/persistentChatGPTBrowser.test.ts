import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  showMessageBox: vi.fn(),
  hostRequest: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock("../../preview/PersistentChatGPTBrowser.ts", () => ({
  persistentChatGPTRequest: mocks.hostRequest,
}));

import { persistentChatGPTRequestIpc } from "./persistentChatGPTBrowser.ts";

const owner = {
  isDestroyed: () => false,
  webContents: { id: 5, getURL: () => "t3code://app" },
};
const sender = { sender: { id: 5 } };

beforeEach(() => {
  mocks.getAllWindows.mockReset().mockReturnValue([owner]);
  mocks.showMessageBox.mockReset();
  mocks.hostRequest.mockReset().mockResolvedValue({ reset: true });
});

describe("Reset webviews native confirmation", () => {
  it.effect("uses a modal owned by T3, with Cancel as the safe default", () =>
    Effect.gen(function* () {
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const result = yield* persistentChatGPTRequestIpc.handler(
        { operation: "confirm_reset_host" },
        sender,
      );

      expect(result).toEqual({ reset: false });
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({
          buttons: ["Reset webviews", "Cancel"],
          defaultId: 1,
          cancelId: 1,
        }),
      );
      expect(mocks.hostRequest).not.toHaveBeenCalled();
    }),
  );

  it.effect("resets only after native confirmation", () =>
    Effect.gen(function* () {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const result = yield* persistentChatGPTRequestIpc.handler(
        { operation: "confirm_reset_host" },
        sender,
      );

      expect(result).toEqual({ reset: true });
      expect(mocks.hostRequest).toHaveBeenCalledExactlyOnceWith({ operation: "reset_host" });
    }),
  );

  it.effect("does not show the modal to a foreign renderer", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        persistentChatGPTRequestIpc.handler(
          { operation: "confirm_reset_host" },
          { sender: { id: 6 } },
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    }),
  );
});
