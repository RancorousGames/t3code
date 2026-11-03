/** Native Electron WebContentsViews render above every HTML z-index. When a T3
 * popover overlaps the page we must temporarily hide the native view. The
 * webContents stays alive (including drafts and running generations). */
export const NATIVE_CHATGPT_OVERLAY_SELECTOR = [
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="dropdown-menu-content"]',
  // Hovercards use a separate native popup; no blanking the Chrome view.
  // Keep these selectors ONLY to trigger tooltip reinspection on DOM changes.
  '[data-slot="tooltip-positioner"]',
  '[data-slot="tooltip-popup"]',
].join(", ");

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function nativeChatGPTOverlayOverlaps(
  doc: Document,
  nativeBounds: DOMRect,
  legacyTooltipFallback = false,
): boolean {
  if (nativeBounds.width <= 1 || nativeBounds.height <= 1) return false;
  return [...doc.querySelectorAll<HTMLElement>(NATIVE_CHATGPT_OVERLAY_SELECTOR)].some((element) => {
    // Toasts are role="dialog" too, but a notification must never blank the page.
    if (
      element.closest('[hidden],[aria-hidden="true"],[inert],[data-slot="toast-viewport"]') ||
      element.hasAttribute("data-closed")
    )
      return false;
    const style = doc.defaultView?.getComputedStyle(element);
    if (!style || style.visibility === "hidden" || style.display === "none") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // Preserve pre-existing menu/dialog behavior: an open modal can have a
    // backdrop over the native page even when the dialog itself is elsewhere.
    // For hover tooltips, hide only when their popup intersects the page.
    const legacyOverlay = element.matches(
      '[role="menu"],[role="dialog"],[role="listbox"],' +
        '[data-slot="context-menu-content"],[data-slot="dropdown-menu-content"]',
    );
    // Older Electron main bundles cannot create a native popup. Preserve the
    // previous safe behavior until the owner is restarted with the native
    // tooltip IPC handler, rather than showing clipped hovercards.
    const oldTooltip =
      legacyTooltipFallback &&
      element.matches(
        '[role="tooltip"],[data-slot="tooltip-positioner"],[data-slot="tooltip-popup"]',
      );
    return (legacyOverlay || oldTooltip) && intersects(nativeBounds, rect);
  });
}

/** Restrict expensive remeasurement to mutations of overlays and their portals. */
export function mutationTouchesNativeChatGPTOverlay(mutation: MutationRecord): boolean {
  const isOverlay = (node: Node) =>
    node.nodeType === 1 &&
    ((node as Element).matches(NATIVE_CHATGPT_OVERLAY_SELECTOR) ||
      (node as Element).querySelector(NATIVE_CHATGPT_OVERLAY_SELECTOR) !== null);
  if (mutation.type === "attributes" || mutation.type === "characterData") {
    const target = mutation.target;
    const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
    return (
      !!element && (isOverlay(element) || element.closest(NATIVE_CHATGPT_OVERLAY_SELECTOR) !== null)
    );
  }
  return (
    (mutation.target ? isOverlay(mutation.target) : false) ||
    [...mutation.addedNodes, ...mutation.removedNodes].some(isOverlay)
  );
}
