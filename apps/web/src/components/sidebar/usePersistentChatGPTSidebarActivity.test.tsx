// @vitest-environment node
// @ts-expect-error jsdom runtime is provided by the desktop test harness.
import { JSDOM } from "jsdom";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { usePersistentChatGPTSidebarActivity } from "./usePersistentChatGPTSidebarActivity";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { readChatGPTIdleTransition } from "../../chatGPTIdleTransitions";

const id = "dfe75455-3c4e-45d3-8b8b-b92f901ddbaa";
const environmentId = "local";
const bridge = vi.fn(async (request: { operation: string }) =>
  request.operation === "probe"
    ? { residency: "resident" as const, destroyed: false, url: "https://chatgpt.com/c/6ae6158e-c624-83ed-9510-51bae6264a51" }
    : { result: "idle" },
);
let renderer: ReactTestRenderer | undefined;
let dom: JSDOM;
const updateWorkingAt = vi.fn();

function Observer({ selected }: { selected: boolean }) {
  const status = usePersistentChatGPTSidebarActivity(
    id, environmentId, true, false, 0, updateWorkingAt, selected,
  );
  return <span>{status.age}</span>;
}

async function mount(selected: boolean) {
  await act(async () => {
    renderer = create(<Observer selected={selected} />);
  });
}
const evaluations = () => bridge.mock.calls.filter(([request]) => request.operation === "evaluate").length;

beforeEach(() => {
  dom = new JSDOM("", { url: "https://chatgpt.com", pretendToBeVisual: true });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(window, { desktopBridge: { stableChatGPTViewRequest: bridge } });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  bridge.mockClear();
  updateWorkingAt.mockClear();
  bridge.mockImplementation(async (request) => request.operation === "probe"
    ? { residency: "resident" as const, destroyed: false, url: "https://chatgpt.com/c/6ae6158e-c624-83ed-9510-51bae6264a51" }
    : { result: "idle" });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("persistent Chrome sidebar responsiveness", () => {
  it("reports a working-to-idle transition within 1.25 seconds", async () => {
    let activity = "working";
    bridge.mockImplementation(async (request) => request.operation === "probe"
      ? { residency: "resident" as const, destroyed: false, url: "https://chatgpt.com/c/6ae6158e-c624-83ed-9510-51bae6264a51" }
      : { result: activity });
    await mount(true);
    expect(renderer!.root.findByType("span").props.children).toBe("working");
    const initial = evaluations();
    activity = "idle";
    await act(async () => { await vi.advanceTimersByTimeAsync(1_350); });
    expect(evaluations()).toBeGreaterThan(initial);
    expect(renderer!.root.findByType("span").props.children).toBe("inactive");
  });

  it("publishes a guarded native Chromium completion after two independent idle snapshots", async () => {
    const conversation="6ae6158e-c624-83ed-9510-51bae6264a51";
    getChatGPTSessionPersistedStore(environmentId).setState({
      ...getChatGPTSessionPersistedStore(environmentId).getState(),
      sessions:[{id,title:"Native idle canary",conversationId:conversation}],
    });
    let activity:"working"|"idle"="working";
    bridge.mockImplementation(async(request) => request.operation === "probe"
      ? {residency:"resident" as const,destroyed:false,url:`https://chatgpt.com/c/${conversation}`}
      : {result:{activity,snapshot:{
        url:`https://chatgpt.com/c/${conversation}`,conversationId:conversation,
        observedAt:Date.now(),activity,turnCount:2,contentHash:"12345678",
        lastTurnRole:"assistant",lastAssistant:{text:"Completed",truncated:false,endsWithQuestion:false},
        signals:{stopButton:activity==="working",interruptedBanner:false,loadError:false,
          composerPresent:true,draftPresent:false,signInOrCaptcha:false,conversationFull:false},
      }}});
    await mount(true);
    expect(readChatGPTIdleTransition(environmentId,id)).toBeNull();
    activity="idle";
    await act(async()=>{await vi.advanceTimersByTimeAsync(1_350);});
    expect(readChatGPTIdleTransition(environmentId,id)).toBeNull();
    await act(async()=>{await vi.advanceTimersByTimeAsync(1_000);});
    expect(readChatGPTIdleTransition(environmentId,id)).toMatchObject({
      environmentId,sessionId:id,conversationId:conversation,sequence:1,
      bindingRevision:null,
    });
    await act(async()=>{await vi.advanceTimersByTimeAsync(1_300);});
    expect(readChatGPTIdleTransition(environmentId,id)?.sequence).toBe(1);
  });

  it("keeps background idle pages on the slow cadence", async () => {
    await mount(false);
    const initial = evaluations();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(evaluations()).toBe(initial);
  });

  it("reacts to a targeted event promptly and ignores unrelated sessions", async () => {
    await mount(false);
    const initial = evaluations();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("t3:chromium-sidebar-probe", {
        detail: { environmentId, sessionId: "not-this-session" },
      }));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(evaluations()).toBe(initial);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("t3:chromium-sidebar-probe", {
        detail: { environmentId, sessionId: id },
      }));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(evaluations()).toBeGreaterThan(initial);
  });
});
