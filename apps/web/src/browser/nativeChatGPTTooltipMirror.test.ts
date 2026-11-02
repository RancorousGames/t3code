// @vitest-environment node
// @ts-expect-error jsdom is available in the project test environment.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { nativeTooltipMirror } from "./nativeChatGPTTooltipMirror";

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;

describe("native T3 hovercard mirroring", () => {
  it("clones a tooltip above the Chrome panel without altering the original", () => {
    const dom =
      new JSDOM(`<div data-slot="tooltip-popup" style="background-color:rgb(20, 20, 20); color:white">
      <div>Created: October 31</div><strong>Last active</strong>
    </div>`);
    const el = dom.window.document.querySelector<HTMLElement>("div")!;
    el.getBoundingClientRect = () => rect(25, 80, 350, 300);
    const result = nativeTooltipMirror(dom.window.document, rect(58, 0, 1100, 800));
    expect(result?.bounds).toEqual({ x: 25, y: 80, width: 350, height: 300 });
    expect(result?.html).toContain("Created: October 31");
    expect(result?.html).toContain("background-color:rgb(20, 20, 20)");
    expect(el.innerHTML).toContain("Last active");
    dom.window.close();
  });

  it("shows an opening hovercard immediately, rather than freezing its fade-in at opacity zero", () => {
    const dom = new JSDOM(`<div data-slot="tooltip-popup" data-starting-style style="opacity:0">
      <div data-current style="opacity:0">NEW WEBVIEW</div>
    </div>`);
    const popup = dom.window.document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
    popup.getBoundingClientRect = () => rect(200, 40, 240, 170);
    const native = rect(210, 0, 1000, 800);
    const mirrored = nativeTooltipMirror(dom.window.document, native);
    expect(mirrored?.html).toMatch(/data-slot="tooltip-popup"[^>]*style="[^"]*opacity: 1/);
    expect(mirrored?.html).toMatch(/data-current[^>]*style="[^"]*opacity: 1/);
    expect(popup.style.opacity).toBe("0");

    popup.setAttribute("data-ending-style", "");
    expect(nativeTooltipMirror(dom.window.document, native)).toBeNull();
    dom.window.close();
  });

  it("never passes scripts, remote URLs, or event handlers into a native tooltip", () => {
    const dom = new JSDOM(`<div data-slot="tooltip-popup">
      <p onclick="alert(1)">Safe &amp; escaped</p>
      <img src="https://example.com/tracker.png" onerror="alert(1)">
      <script>alert("bad")</script>
    </div>`);
    dom.window.document.querySelector<HTMLElement>("div")!.getBoundingClientRect = () =>
      rect(0, 0, 300, 250);
    const result = nativeTooltipMirror(dom.window.document, rect(58, 0, 1000, 800));
    expect(result?.html).toContain("Safe &amp; escaped");
    expect(result?.html).not.toMatch(/<script|onclick|onerror|example\.com/i);
    dom.window.close();
  });

  it("does not clone tooltips entirely outside the native browser", () => {
    const dom = new JSDOM('<div data-slot="tooltip-popup">Sidebar</div>');
    dom.window.document.querySelector<HTMLElement>("div")!.getBoundingClientRect = () =>
      rect(0, 100, 45, 100);
    expect(nativeTooltipMirror(dom.window.document, rect(58, 0, 1000, 800))).toBeNull();
    dom.window.close();
  });
});
