// @vitest-environment node
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocked = vi.hoisted(() => ({
  recover: vi.fn(async (_options: unknown) => "already-open"),
}));
vi.mock("../../chatGPTSelectedSessionRecovery", () => ({
  recoverSelectedBlankChatGPTSession: mocked.recover,
}));
import { ChatGPTBrowserSelectionRecovery } from "./ChatGPTBrowserSelectionRecovery";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  mocked.recover.mockClear();
  vi.unstubAllGlobals();
});

describe("select/reselect ChatGPT session recovery trigger", () => {
  it("probes an already-loaded selected tab, and reruns when the same row is clicked again", async () => {
    await act(async () => {
      renderer = create(<ChatGPTBrowserSelectionRecovery
        environmentId={"local" as never} sessionId="selected" enabled clickToken={1} />);
    });
    expect(mocked.recover).toHaveBeenCalledOnce();
    const previousCurrent = (mocked.recover.mock.calls[0]?.[0] as {isCurrent:()=>boolean}).isCurrent;
    await act(async () => {
      renderer?.update(<ChatGPTBrowserSelectionRecovery
        environmentId={"local" as never} sessionId="selected" enabled clickToken={2} />);
    });
    expect(previousCurrent()).toBe(false);
    expect(mocked.recover).toHaveBeenCalledTimes(2);
    expect(mocked.recover.mock.calls[1]?.[0]).toMatchObject({
      environmentId: "local", sessionId: "selected", isCurrent: expect.any(Function),
    });
  });
  it("does not attempt recovery when a session is hidden or missing", async () => {
    await act(async () => {
      renderer = create(<ChatGPTBrowserSelectionRecovery
        environmentId={"local" as never} sessionId="hidden" enabled={false} clickToken={0} />);
    });
    expect(mocked.recover).not.toHaveBeenCalled();
    await act(async () => {
      renderer?.update(<ChatGPTBrowserSelectionRecovery
        environmentId={"local" as never} sessionId={undefined} enabled clickToken={1} />);
    });
    expect(mocked.recover).not.toHaveBeenCalled();
  });
});
