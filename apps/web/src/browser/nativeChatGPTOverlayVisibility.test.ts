// @vitest-environment node
// @ts-expect-error jsdom is bundled for the desktop test harness.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import {
  mutationTouchesNativeChatGPTOverlay,
  nativeChatGPTOverlayOverlaps,
} from "./nativeChatGPTOverlayVisibility";

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

describe("native Chromium and T3 tooltip stacking", () => {
  it("does not hide native pixels when a Base UI hovercard overlaps", () => {
    const dom = new JSDOM(
      '<main><div data-slot="tooltip-positioner"><div data-slot="tooltip-popup">Preview</div></div></main>',
    );
    const positioner = dom.window.document.querySelector<HTMLElement>(
      '[data-slot="tooltip-positioner"]',
    )!;
    const popup = dom.window.document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
    positioner.getBoundingClientRect = () => rect(26, 120, 280, 350);
    popup.getBoundingClientRect = () => rect(26, 120, 280, 350);
    expect(nativeChatGPTOverlayOverlaps(dom.window.document, rect(58, 0, 1000, 800))).toBe(false);
    expect(nativeChatGPTOverlayOverlaps(dom.window.document, rect(58, 0, 1000, 800), true)).toBe(
      true,
    );
    dom.window.close();
  });

  it("does not blank native Chromium for a tooltip completely outside the page", () => {
    const dom = new JSDOM('<div data-slot="tooltip-positioner">Left</div>');
    const el = dom.window.document.querySelector<HTMLElement>("div")!;
    el.getBoundingClientRect = () => rect(0, 100, 50, 100);
    expect(nativeChatGPTOverlayOverlaps(dom.window.document, rect(58, 0, 1000, 800))).toBe(false);
    dom.window.close();
  });

  it("ignores closed, hidden or unrelated UI; preserves existing menu handling", () => {
    const dom = new JSDOM(
      '<div data-slot="tooltip-popup" hidden>Closed</div><div data-slot="context-menu-content">Menu</div>',
    );
    const [tooltip, menu] = [...dom.window.document.querySelectorAll<HTMLElement>("div")];
    tooltip!.getBoundingClientRect = () => rect(30, 30, 200, 200);
    menu!.getBoundingClientRect = () => rect(30, 30, 200, 200);
    const native = rect(58, 0, 1000, 800);
    expect(nativeChatGPTOverlayOverlaps(dom.window.document, native)).toBe(true);
    menu!.remove();
    expect(nativeChatGPTOverlayOverlaps(dom.window.document, native)).toBe(false);
    dom.window.close();
  });

  it("keeps the page visible under a toast, which is also role=dialog", () => {
    const dom = new JSDOM(
      '<div data-slot="toast-viewport"><div role="dialog" aria-modal="false">Update</div></div>',
    );
    const toast = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!;
    toast.getBoundingClientRect = () => rect(100, 10, 360, 96);
    expect(nativeChatGPTOverlayOverlaps(dom.window.document, rect(58, 0, 1000, 800))).toBe(false);
    dom.window.close();
  });

  it("recognizes tooltip portal insertions and visibility attribute changes", () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const doc = dom.window.document;
    const root = doc.getElementById("root")!;
    const tip = doc.createElement("div");
    tip.dataset.slot = "tooltip-positioner";
    const unrelated = doc.createElement("div");
    expect(
      mutationTouchesNativeChatGPTOverlay({
        type: "childList",
        addedNodes: [tip] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as MutationRecord),
    ).toBe(true);
    expect(
      mutationTouchesNativeChatGPTOverlay({
        type: "childList",
        addedNodes: [unrelated] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as MutationRecord),
    ).toBe(false);
    root.appendChild(tip);
    expect(
      mutationTouchesNativeChatGPTOverlay({
        type: "attributes",
        target: tip,
      } as MutationRecord),
    ).toBe(true);
    dom.window.close();
  });
});
