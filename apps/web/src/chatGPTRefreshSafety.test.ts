// @vitest-environment node
// @ts-expect-error jsdom has no types in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  assertChatGPTRefreshSafe,
  navigateChatGPTRefreshSafe,
  wakeChatGPTRefreshPredecessor,
} from "./chatGPTSessionControl";

const id = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
const environment = EnvironmentId.make("refresh-lab");
const session = { id: "browser", title: "Lab" };
vi.mock("./browser/previewRuntimeTabId", () => ({ previewRuntimeTabId: () => "refresh-runtime" }));
let hibernated = false;
const wake = vi.fn((_runtimeId: string) => {
  hibernated = false;
});
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  isChatGPTGuestHibernated: () => hibernated,
  wakeChatGPTGuest: (runtimeId: string) => wake(runtimeId),
  touchChatGPTGuest: vi.fn(),
}));
vi.mock("./previewStateStore", () => ({
  readThreadPreviewState: () => ({
    activeTabId: "tab",
    serverEpoch: "epoch",
    desktopByTabId: { tab: { loading: false } },
    sessions: {
      tab: {
        navStatus: {
          _tag: "Success",
          url: "https://chatgpt.com/c/6ad81f45-bd10-83ed-8128-6a3d584c876c",
        },
      },
    },
  }),
}));
let dom: JSDOM;
let working = false;
let pending = false;
let text = "";
let writer = vi.fn(async () => ({ uncertainSendPresent: false }));
let navigate = vi.fn();
beforeEach(() => {
  dom = new JSDOM(
    `<div id="prompt-textarea" contenteditable="true"></div>
    <div data-message-author-role="user">hello</div><div data-message-author-role="assistant">reply</div>`,
    { url: `https://chatgpt.com/c/${id}` },
  );
  working = false;
  hibernated = false;
  wake.mockClear();
  pending = false;
  text = "";
  writer = vi.fn(async () => ({ uncertainSendPresent: false }));
  navigate = vi.fn();
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", { desktopBridge: { savePrivateChatGPTDraftSnapshot: writer } });
  vi.spyOn(dom.window.Element.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as DOMRectList);
  const guest = document.createElement("webview");
  guest.dataset.previewTab = "refresh-runtime";
  Object.defineProperty(guest, "executeJavaScript", {
    value: async (script: string) => {
      if (script.includes("const page =")) {
        return new Function(
          "document",
          "location",
          "HTMLElement",
          "HTMLTextAreaElement",
          "Element",
          "Node",
          "NodeFilter",
          `return ${script}`,
        )(
          document,
          {
            hostname: "chatgpt.com",
            pathname: `/c/${id}`,
            href: `https://chatgpt.com/c/${id}`,
            assign: navigate,
          },
          dom.window.HTMLElement,
          dom.window.HTMLTextAreaElement,
          dom.window.Element,
          dom.window.Node,
          dom.window.NodeFilter,
        );
      }
      if (script.includes("inspectChatGPTComposer"))
        return { status: text ? "nonempty" : "empty", text, url: `https://chatgpt.com/c/${id}` };
      if (script.includes("const result ="))
        return {
          url: `https://chatgpt.com/c/${id}`,
          activity: working ? "working" : "idle",
          lastRole: pending ? "user" : "assistant",
          assistantHasContent: !pending,
          stuck: false,
          connectionInterrupted: false,
        };
      throw new Error("Unexpected safety inspection");
    },
  });
  document.body.appendChild(guest);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("refresh loaded guest safety and atomic navigation", () => {
  it("wakes a hibernated predecessor in its existing slot before the private draft backup", async () => {
    hibernated = true;
    await wakeChatGPTRefreshPredecessor(environment, session, id);
    expect(wake).toHaveBeenCalledExactlyOnceWith("refresh-runtime");
    const runtime = await assertChatGPTRefreshSafe(environment, session, id);
    expect(runtime).toBe("refresh-runtime");
    expect(writer).toHaveBeenCalledTimes(1);
  });
  it("does not replace a temporarily unmounted predecessor or bypass its backing state", async () => {
    document.querySelector("webview")?.remove();
    await expect(wakeChatGPTRefreshPredecessor(environment, session, id, 1)).rejects.toThrow(
      "still recovering",
    );
    expect(wake).toHaveBeenCalledExactlyOnceWith("refresh-runtime");
    expect(writer).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("rejects wrong known conversation without waking or allocating a replacement", async () => {
    await expect(
      wakeChatGPTRefreshPredecessor(environment, session, "ffffffff-ffff-ffff-ffff-ffffffffffff"),
    ).rejects.toThrow("Saved predecessor");
    expect(wake).not.toHaveBeenCalled();
  });
  it("backs up an empty completed predecessor before navigating the same guest", async () => {
    const runtime = await assertChatGPTRefreshSafe(environment, session, id);
    expect(writer).toHaveBeenCalledTimes(1);
    await navigateChatGPTRefreshSafe(environment, session, runtime, id, "https://chatgpt.com/");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/");
  });
  it.each(["draft", "generating", "pending", "backup"])(
    "refuses %s before navigation",
    async (condition) => {
      if (condition === "draft") text = "unsent human draft";
      if (condition === "generating") working = true;
      if (condition === "pending") pending = true;
      if (condition === "backup") writer.mockRejectedValueOnce(new Error("disk full"));
      await expect(assertChatGPTRefreshSafe(environment, session, id)).rejects.toThrow();
      expect(navigate).not.toHaveBeenCalled();
    },
  );
  it("rejects a draft typed after backup in the same guest task as navigation", async () => {
    const runtime = await assertChatGPTRefreshSafe(environment, session, id);
    document.querySelector("#prompt-textarea")!.textContent = "new draft";
    await expect(
      navigateChatGPTRefreshSafe(environment, session, runtime, id, "https://chatgpt.com/"),
    ).rejects.toThrow("declined");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("rejects active model work started after backup", async () => {
    const runtime = await assertChatGPTRefreshSafe(environment, session, id);
    const stop = document.createElement("button");
    stop.dataset.testid = "stop-button";
    document.body.appendChild(stop);
    await expect(
      navigateChatGPTRefreshSafe(environment, session, runtime, id, "https://chatgpt.com/"),
    ).rejects.toThrow("declined");
    expect(navigate).not.toHaveBeenCalled();
  });
});
