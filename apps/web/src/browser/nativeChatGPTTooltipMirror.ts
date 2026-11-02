/** Render a noninteractive T3 hovercard in a native overlay without moving the
 * live ChatGPT WebContentsView or copying React component state. Computed CSS
 * is captured at the UI boundary; the native popup uses no application JS. */
export interface NativeTooltipMirror {
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly html: string;
}

const CSS_PROPS = [
  "display",
  "visibility",
  "position",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "background",
  "background-color",
  "backdrop-filter",
  "-webkit-backdrop-filter",
  "box-shadow",
  "opacity",
  "color",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-transform",
  "white-space",
  "overflow",
  "overflow-wrap",
  "word-break",
  "text-overflow",
  "flex",
  "flex-direction",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "align-items",
  "justify-content",
  "align-self",
  "gap",
  "column-gap",
  "row-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "fill",
  "stroke",
  "stroke-width",
  "vertical-align",
] as const;

const BLOCKED_ELEMENTS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "LINK"]);

export function nativeTooltipMirror(
  doc: Document,
  nativeBounds: DOMRect,
): NativeTooltipMirror | null {
  const win = doc.defaultView;
  if (!win) return null;
  const intersects = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const popup = [...doc.querySelectorAll<HTMLElement>('[data-slot="tooltip-popup"]')].find(
    (element) => {
      if (
        element.closest('[hidden],[inert],[aria-hidden="true"]') ||
        element.hasAttribute("data-ending-style") ||
        element.hasAttribute("data-closed")
      )
        return false;
      const style = win.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 1 && bounds.height > 1 && intersects(bounds, nativeBounds);
    },
  );
  if (!popup) return null;
  const rect = popup.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (width <= 0 || height <= 0 || width > 1000 || height > 1400) return null;

  let elements = 0;
  const copy = (source: Element): Element | null => {
    if (BLOCKED_ELEMENTS.has(source.tagName) || ++elements > 280) return null;
    const target = source.cloneNode(false) as Element;
    // Do not transfer arbitrary event handlers, remote image URLs, or scripts
    // into the isolated popup. Hover previews are presentational only.
    for (const attribute of [...target.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ["href", "src", "srcset", "formaction", "target"].includes(attribute.name)
      )
        target.removeAttribute(attribute.name);
    }
    const computed = win.getComputedStyle(source);
    const style = CSS_PROPS.map((name) => {
      const value = computed.getPropertyValue(name);
      return value ? `${name}:${value}` : "";
    })
      .filter(Boolean)
      .join(";");
    target.setAttribute("style", style);
    // The source tooltip fades in from opacity 0. A native mirror is a static
    // snapshot, so copying that first frame leaves it invisible until another
    // DOM mutation (often the closing animation). Show open content immediately.
    if (source === popup || source.hasAttribute("data-current")) {
      (target as HTMLElement).style.opacity = "1";
    }
    for (const child of source.childNodes) {
      if (child.nodeType === 3) target.appendChild(doc.createTextNode(child.textContent ?? ""));
      else if (child.nodeType === 1) {
        const cloned = copy(child as Element);
        if (cloned) target.appendChild(cloned);
      }
    }
    return target;
  };
  const cloned = copy(popup);
  if (!cloned) return null;
  // Isolated popup origin applies strict CSP. Cap IPC payloads for oversized
  // hover cards; never send a partial HTML document.
  const html = cloned.outerHTML;
  if (html.length > 110_000) return null;
  return {
    bounds: {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.max(1, width),
      height: Math.max(1, height),
    },
    html,
  };
}
