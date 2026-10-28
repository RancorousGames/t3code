// @vitest-environment node
// @ts-expect-error jsdom test runtime is installed without its type declarations.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHATGPT_ACTIVITY_EXPRESSION,
  CHATGPT_RECENT_ACTIVITY_MS,
  chatGPTActivityAge,
  chatGPTActivityColorClass,
} from "./chatGPTActivity";

const readActivity = () => window.eval(CHATGPT_ACTIVITY_EXPRESSION);
let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: "https://chatgpt.com/c/test", runScripts: "outside-only" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("NodeFilter", dom.window.NodeFilter);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal("location", { hostname: "chatgpt.com" });
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("ChatGPT activity recency", () => {
  const now = 18_000_000;

  it("keeps an actively working session green regardless of previous activity", () => {
    expect(chatGPTActivityAge("working", 0, now)).toBe("working");
    expect(chatGPTActivityColorClass("working")).toBe("text-lime-500! dark:text-lime-400!");
  });

  it("shows blue for 2 hours after the last observed work", () => {
    expect(chatGPTActivityAge("idle", now - CHATGPT_RECENT_ACTIVITY_MS + 1, now)).toBe("recent");
    expect(chatGPTActivityColorClass("recent")).toContain("text-[#5d82a9]!");
  });

  it("shows inactive grey after 2 hours or without any recorded work", () => {
    expect(chatGPTActivityAge("idle", now - CHATGPT_RECENT_ACTIVITY_MS, now)).toBe("inactive");
    for (const timestamp of [0, -1, NaN, Infinity, now + 1]) {
      expect(chatGPTActivityAge("idle", timestamp, now)).toBe("inactive");
    }
    expect(chatGPTActivityColorClass("inactive")).toBe("text-muted-foreground!");
  });

  it("reserves a different grey for unknown, regardless of historical activity", () => {
    expect(chatGPTActivityAge("unknown", now - 1_000, now)).toBe("unknown");
    expect(chatGPTActivityAge("unknown", 0, now)).toBe("unknown");
    expect(chatGPTActivityColorClass("unknown")).toContain("text-sidebar-muted-foreground/60!");
  });

  it("prioritizes unavailable red and interrupted orange over previous activity", () => {
    expect(chatGPTActivityAge("invalid", now - 1_000, now)).toBe("invalid");
    expect(chatGPTActivityAge("interrupted", now - 1_000, now)).toBe("interrupted");
    expect(chatGPTActivityAge("delivery-timeout", now - 1_000, now)).toBe("delivery-timeout");
    expect(chatGPTActivityColorClass("invalid")).toContain("text-rose-600/80!");
    expect(chatGPTActivityColorClass("interrupted")).toContain("text-orange-700!");
    expect(chatGPTActivityColorClass("delivery-timeout")).toBe(
      chatGPTActivityColorClass("interrupted"),
    );
  });
});

describe("ChatGPT composer activity", () => {
  it("detects generation from the Stop control", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><button data-testid="stop-button">Stop</button>';
    expect(readActivity()).toBe("working");
  });
  it("recognizes the composer Stop control used by working sessions", () => {
    for (const attributes of ['data-testid="composer-stop-button"', 'aria-label="Stop"']) {
      document.body.innerHTML = `<div id="prompt-textarea"></div><button ${attributes}></button>`;
      expect(readActivity()).toBe("working");
    }
  });
  it("recognizes accessible Stop controls without a test id", () => {
    document.body.innerHTML = '<button aria-label="Stop streaming"></button>';
    expect(readActivity()).toBe("working");
  });
  it("detects idle when the composer has no Stop control", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><button aria-label="Send prompt"></button>';
    expect(readActivity()).toBe("idle");
  });
  it("ignores disabled and hidden Stop controls", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><button data-testid="stop-button" disabled></button>';
    expect(readActivity()).toBe("idle");
    const stop = document.querySelector("button")!;
    stop.removeAttribute("disabled");
    Object.defineProperty(stop, "getClientRects", { value: () => [] });
    expect(readActivity()).toBe("idle");
  });
  it("marks fully loaded pages without a composer as unavailable", () => {
    document.body.innerHTML = "<main>Sign in</main>";
    expect(readActivity()).toBe("invalid: the ChatGPT composer is unavailable");
  });
  it("does not treat other sites or a voice-recording Stop control as generation", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><button aria-label="Stop recording"></button>';
    expect(readActivity()).toBe("idle");
    dom.reconfigure({ url: "https://example.com/" });
    expect(readActivity()).toBe("invalid: this page is not on ChatGPT");
  });

  it("marks the exact visible conversation error with Retry as unavailable", () => {
    document.body.innerHTML =
      "<main><h2>Could not load this ChatGPT conversation</h2><button>Retry</button></main>";
    expect(readActivity()).toBe("invalid: Could not load this ChatGPT conversation");
  });

  it("does not mistake a quoted or hidden load error for an actual failure", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div>' +
      '<div data-message-author-role="user">Could not load this ChatGPT conversation</div>' +
      "<button>Retry</button>";
    expect(readActivity()).toBe("idle");

    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div hidden>' +
      "<h2>Could not load this ChatGPT conversation</h2><button>Retry</button></div>";
    expect(readActivity()).toBe("idle");
  });

  it("shows an interrupted connection even with a visible Stop button", () => {
    document.body.innerHTML =
      '<button data-testid="stop-button">Stop</button>' +
      '<div role="status">Connection interrupted. Waiting for the complete answer</div>';
    expect(readActivity()).toBe("interrupted");
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div role="status">' +
      "<span>Connection interrupted.</span><span> Waiting for the complete answer</span></div>";
    expect(readActivity()).toBe("interrupted");
  });

  it("shows orange for a visible message delivery timeout, even with a Stop button", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><button data-testid="stop-button">Stop</button>' +
      '<div role="alert">Message delivery timed out. Please try again.</div>';
    expect(readActivity()).toBe("delivery-timeout");

    // ChatGPT may render the status sentence in separate text elements.
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div role="status">' +
      "<span>Message delivery</span><span> timed out.</span>" +
      "<span> Please try again.</span></div>";
    expect(readActivity()).toBe("delivery-timeout");

    // A failed assistant turn can display an inline error, not a toast.
    document.body.innerHTML =
      '<div id="prompt-textarea"></div>' +
      '<div data-message-author-role="assistant"><div>Message delivery timed out. Please try again.</div></div>';
    expect(readActivity()).toBe("delivery-timeout");

    // A standalone page error is also valid, even without a status role.
    document.body.innerHTML =
      '<div id="prompt-textarea"></div>' +
      "<div><span>Message delivery timed out. Please try again.</span></div>";
    expect(readActivity()).toBe("delivery-timeout");
  });

  it("does not mistake quoted, embedded, or hidden timeout messages for delivery errors", () => {
    const timeout = "Message delivery timed out. Please try again.";
    for (const tag of [
      '<div data-message-author-role="user">',
      '<div data-message-author-role="assistant"><div class="markdown">',
      "<pre>",
      "<blockquote>",
      "<div hidden>",
    ]) {
      const closing = tag.startsWith("<pre")
        ? "</pre>"
        : tag.startsWith("<blockquote")
          ? "</blockquote>"
          : tag.includes('class="markdown"')
            ? "</div></div>"
            : "</div>";
      document.body.innerHTML = `<div id="prompt-textarea"></div>${tag}${timeout}${closing}`;
      expect(readActivity()).toBe("idle");
    }
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div role="status">' +
      "This article mentions: Message delivery timed out. Please try again.</div>";
    expect(readActivity()).toBe("idle");
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div role="status">Message delivery timed out. Please try again.</div>';
    expect(readActivity()).toBe("delivery-timeout");
    document.body.innerHTML = '<div id="prompt-textarea"></div>';
    expect(readActivity()).toBe("idle");
  });

  it("does not mistake quoted or hidden interruption messages for a lost connection", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div data-message-author-role="user">' +
      "Connection interrupted. Waiting for the complete answer</div>";
    expect(readActivity()).toBe("idle");
    document.body.innerHTML =
      '<div id="prompt-textarea"></div><div hidden role="status">' +
      "Connection interrupted. Waiting for the complete answer</div>";
    expect(readActivity()).toBe("idle");
    document.body.innerHTML = '<div id="prompt-textarea"></div>';
    expect(readActivity()).toBe("idle");
  });
});
