// @vitest-environment node
// @ts-expect-error jsdom has no types in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  assertChatGPTRebootSafe,
  navigateChatGPTRebootSafe,
  wakeChatGPTRebootPredecessor,
  hasUncertainChatGPTSend,
} from "./chatGPTSessionControl";
import {
  reserveDurableUnknownChatGPTSend,
  releaseDurableUnknownChatGPTSend,
} from "./chatGPTUncertainSendFence";

const id = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
const environment = EnvironmentId.make("reboot-lab");
const session = { id: "browser", title: "Lab" };
vi.mock("./browser/previewRuntimeTabId", () => ({ previewRuntimeTabId: () => "reboot-runtime" }));
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
  vi.stubGlobal("window", {
    localStorage: dom.window.localStorage,
    desktopBridge: { savePrivateChatGPTDraftSnapshot: writer },
  });
  vi.spyOn(dom.window.Element.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as DOMRectList);
  const guest = document.createElement("webview");
  guest.dataset.previewTab = "reboot-runtime";
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
        return document.querySelector("#prompt-textarea")
          ? { status: text ? "nonempty" : "empty", text, url: `https://chatgpt.com/c/${id}` }
          : { status: "unknown", url: `https://chatgpt.com/c/${id}` };
      if (script.includes("const result ="))
        return {
          url: `https://chatgpt.com/c/${id}`,
          activity: working
            ? "working"
            : document.querySelector("#prompt-textarea")
              ? "idle"
              : "unknown",
          conversationFull: !!document
            .querySelector('[role="alert"]')
            ?.textContent?.includes("too long"),
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

describe("reboot loaded guest safety and atomic navigation", () => {
  it("refuses reboot when an UNKNOWN send survived renderer restart without its original text", async () => {
    const url = `https://chatgpt.com/c/${id}`;
    reserveDurableUnknownChatGPTSend(environment, session.id, url, false);
    expect(hasUncertainChatGPTSend(environment, session.id)).toBe(true);
    await expect(assertChatGPTRebootSafe(environment, session, id)).rejects.toThrow(
      "UNKNOWN sends",
    );
    expect(writer).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    releaseDurableUnknownChatGPTSend(environment, session.id);
    expect(hasUncertainChatGPTSend(environment, session.id)).toBe(false);
  });
  it("wakes a hibernated predecessor in its existing slot before the private draft backup", async () => {
    hibernated = true;
    await wakeChatGPTRebootPredecessor(environment, session, id);
    expect(wake).toHaveBeenCalledExactlyOnceWith("reboot-runtime");
    const runtime = await assertChatGPTRebootSafe(environment, session, id);
    expect(runtime).toBe("reboot-runtime");
    expect(writer).toHaveBeenCalledTimes(1);
  });
  it("does not replace a temporarily unmounted predecessor or bypass its backing state", async () => {
    document.querySelector("webview")?.remove();
    await expect(wakeChatGPTRebootPredecessor(environment, session, id, 1)).rejects.toThrow(
      "still recovering",
    );
    expect(wake).toHaveBeenCalledExactlyOnceWith("reboot-runtime");
    expect(writer).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("rejects wrong known conversation without waking or allocating a replacement", async () => {
    await expect(
      wakeChatGPTRebootPredecessor(environment, session, "ffffffff-ffff-ffff-ffff-ffffffffffff"),
    ).rejects.toThrow("Saved predecessor");
    expect(wake).not.toHaveBeenCalled();
  });
  it("backs up an empty completed predecessor before navigating the same guest", async () => {
    const runtime = await assertChatGPTRebootSafe(environment, session, id);
    expect(writer).toHaveBeenCalledTimes(1);
    await navigateChatGPTRebootSafe(environment, session, runtime, id, "https://chatgpt.com/");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/");
  });
  it("rebootes a stalled user turn without requiring an assistant reply", async () => {
    pending = true;
    document.querySelector('[data-message-author-role="assistant"]')!.remove();
    const runtime = await assertChatGPTRebootSafe(environment, session, id);
    await navigateChatGPTRebootSafe(environment, session, runtime, id, "https://chatgpt.com/");
    expect(writer).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/");
  });
  it.each(["draft", "generating", "backup"])("refuses %s before navigation", async (condition) => {
    if (condition === "draft") text = "unsent human draft";
    if (condition === "generating") working = true;
    if (condition === "backup") writer.mockRejectedValueOnce(new Error("disk full"));
    await expect(assertChatGPTRebootSafe(environment, session, id)).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("backs up and replaces a confirmed hard-limit page only when no editor exists", async () => {
    document.querySelector("#prompt-textarea")!.remove();
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "This conversation is too long";
    document.body.appendChild(alert);
    await wakeChatGPTRebootPredecessor(environment, session, id);
    const runtime = await assertChatGPTRebootSafe(environment, session, id);
    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({ draft: "", url: `https://chatgpt.com/c/${id}` }),
    );
    await navigateChatGPTRebootSafe(environment, session, runtime, id, "https://chatgpt.com/");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/");
  });
  it("never overrides an unsent draft even when the hard-limit notice is visible", async () => {
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "This conversation is too long";
    document.body.appendChild(alert);
    text = "existing human draft";
    await expect(assertChatGPTRebootSafe(environment, session, id)).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("rejects a draft typed after backup in the same guest task as navigation", async () => {
    const runtime = await assertChatGPTRebootSafe(environment, session, id);
    document.querySelector("#prompt-textarea")!.textContent = "new draft";
    await expect(
      navigateChatGPTRebootSafe(environment, session, runtime, id, "https://chatgpt.com/"),
    ).rejects.toThrow("declined");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("rejects active model work started after backup", async () => {
    const runtime = await assertChatGPTRebootSafe(environment, session, id);
    const stop = document.createElement("button");
    stop.dataset.testid = "stop-button";
    document.body.appendChild(stop);
    await expect(
      navigateChatGPTRebootSafe(environment, session, runtime, id, "https://chatgpt.com/"),
    ).rejects.toThrow("declined");
    expect(navigate).not.toHaveBeenCalled();
  });
});
