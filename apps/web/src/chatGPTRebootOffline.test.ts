// @vitest-environment node
// @ts-expect-error jsdom has no types in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { chatGPTBrowserLastUrlKey } from "./chatGPTBrowserSessions";
import {
  inspectOfflineRebootPredecessor,
  inspectErroredRebootPredecessor,
  navigateOfflineChatGPTReboot,
} from "./chatGPTRebootOffline";

const environment = EnvironmentId.make("offline-reboot");
const id = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
const session = { id: "browser", title: "Manager" };
const url = `https://chatgpt.com/c/${id}`;
let dom: JSDOM;
let failure: string | null;
let errorPanel: boolean;
let hiddenEditor: boolean;
let unknownSend: boolean;
let hibernated: boolean;
let loading: boolean;
let navUrl: string;
const reset = vi.fn(async (_runtime: string, _url: string) => ({
  previousWebContentsId: 1,
  webContentsId: 2,
}));

vi.mock("./browser/previewRuntimeTabId", () => ({ previewRuntimeTabId: () => "reboot-runtime" }));
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  isChatGPTGuestHibernated: () => hibernated,
}));
vi.mock("./chatGPTBrowserHealth", () => ({
  chatGPTBrowserFailure: () => failure,
}));
vi.mock("./chatGPTSessionControl", () => ({
  hasUncertainChatGPTSend: () => unknownSend,
}));
vi.mock("./browser/hostedBrowserGuestReset", () => ({
  resetHostedBrowserGuest: (...args: [string, string]) => reset(...args),
}));
vi.mock("./previewStateStore", () => ({
  readThreadPreviewState: () => ({
    activeTabId: "tab",
    serverEpoch: "epoch",
    desktopByTabId: { tab: { loading } },
    sessions: { tab: { navStatus: { _tag: "Success", url: navUrl } } },
  }),
}));

beforeEach(() => {
  dom = new JSDOM("", { url });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  failure = "blank-page";
  errorPanel = false;
  hiddenEditor = false;
  unknownSend = false;
  hibernated = false;
  loading = false;
  navUrl = url;
  reset.mockClear();
  window.localStorage.setItem(
    chatGPTBrowserLastUrlKey(environment, session.id),
    JSON.stringify(url),
  );
  const guest = document.createElement("webview");
  guest.dataset.previewTab = "reboot-runtime";
  Object.defineProperty(guest, "getURL", { value: () => url });
  Object.defineProperty(guest, "executeJavaScript", {
    value: async () => (failure === "blank-page" ? !hiddenEditor : errorPanel),
  });
  document.body.appendChild(guest);
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("offline same-browser reboot", () => {
  it("uses the existing slot without reading the broken conversation", async () => {
    const predecessor = inspectOfflineRebootPredecessor(environment, session, id);
    expect(predecessor).not.toBeNull();
    await navigateOfflineChatGPTReboot(
      environment,
      session,
      id,
      predecessor!,
      "https://chatgpt.com/",
    );
    expect(reset).toHaveBeenCalledExactlyOnceWith("reboot-runtime", "https://chatgpt.com/");
  });

  it("refuses a blank renderer with a hidden draft editor", async () => {
    hiddenEditor = true;
    expect(await inspectErroredRebootPredecessor(environment, session, id)).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it("allows a confirmed ChatGPT load-error page without requiring recovery", async () => {
    failure = null;
    errorPanel = true;
    const predecessor = await inspectErroredRebootPredecessor(environment, session, id);
    expect(predecessor).not.toBeNull();
    await navigateOfflineChatGPTReboot(
      environment,
      session,
      id,
      predecessor!,
      "https://chatgpt.com/",
    );
    expect(reset).toHaveBeenCalledExactlyOnceWith("reboot-runtime", "https://chatgpt.com/");
  });

  it.each(["probe-timeout", null])(
    "does not erase an unreadable or unconfirmed composer (%s)",
    (problem) => {
      failure = problem;
      expect(inspectOfflineRebootPredecessor(environment, session, id)).toBeNull();
    },
  );

  it("refuses wrong predecessor, saved URL, active loading, UNKNOWN send and hibernation", () => {
    expect(
      inspectOfflineRebootPredecessor(environment, session, "ffffffff-ffff-ffff-ffff-ffffffffffff"),
    ).toBeNull();
    navUrl = "https://chatgpt.com/c/ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(inspectOfflineRebootPredecessor(environment, session, id)).toBeNull();
    navUrl = url;
    unknownSend = true;
    expect(inspectOfflineRebootPredecessor(environment, session, id)).toBeNull();
    unknownSend = false;
    loading = true;
    expect(inspectOfflineRebootPredecessor(environment, session, id)).toBeNull();
    loading = false;
    hibernated = true;
    expect(inspectOfflineRebootPredecessor(environment, session, id)).toBeNull();
    hibernated = false;
    window.localStorage.setItem(
      chatGPTBrowserLastUrlKey(environment, session.id),
      JSON.stringify("https://chatgpt.com/"),
    );
    expect(inspectOfflineRebootPredecessor(environment, session, id)).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it("rejects a changed browser or newly uncertain send before replacement", async () => {
    const predecessor = inspectOfflineRebootPredecessor(environment, session, id)!;
    unknownSend = true;
    await expect(
      navigateOfflineChatGPTReboot(environment, session, id, predecessor, "https://chatgpt.com/"),
    ).rejects.toThrow("changed");
    unknownSend = false;
    document.querySelector("webview")!.remove();
    await expect(
      navigateOfflineChatGPTReboot(environment, session, id, predecessor, "https://chatgpt.com/"),
    ).rejects.toThrow("changed");
    expect(reset).not.toHaveBeenCalled();
  });
});
