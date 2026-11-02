/**
 * ChatGPT's editable composer receives synthetic input in the independently
 * hosted Chromium renderer. Because its Win32 window is deliberately not
 * activated (activating it would steal keyboard focus from T3), Chromium does
 * not draw the ordinary blinking text caret even while a contenteditable DOM
 * selection is active.
 *
 * This installs a purely visual, non-interactive caret inside the original GPU
 * page at that selection. It does not move selection, edit text, poll frames or
 * change focus. Re-evaluating is idempotent, including after T3 restarts.
 */
export const INSTALL_PERSISTENT_CHATGPT_CARET = String.raw`(() => {
  const key = "__t3NativeOffscreenCaretV1";
  if (window[key]) {
    window[key].update();
    return true;
  }
  if (!document.documentElement) return false;

  const caret = document.createElement("div");
  caret.setAttribute("data-t3-native-caret", "");
  caret.style.cssText = [
    "position:fixed!important",
    "display:none",
    "pointer-events:none!important",
    "user-select:none!important",
    "width:2px!important",
    "height:18px",
    "z-index:2147483647!important",
    "border:0!important",
    "box-shadow:none!important",
    "transform:translateZ(0)"
  ].join(";");
  document.documentElement.appendChild(caret);
  const blink = caret.animate(
    [
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: 0.49 },
      { opacity: 0, offset: 0.5 },
      { opacity: 0, offset: 1 }
    ],
    { duration: 1060, iterations: Infinity }
  );

  let queued = false;
  function update() {
    const editor = document.activeElement;
    const selection = window.getSelection();
    const valid =
      editor &&
      editor.isContentEditable &&
      selection &&
      selection.isCollapsed &&
      selection.rangeCount === 1 &&
      editor.contains(selection.anchorNode) &&
      !document.hasFocus();
    if (!valid) {
      caret.style.display = "none";
      return;
    }

    const range = selection.getRangeAt(0);
    const editorRect = editor.getBoundingClientRect();
    if (editorRect.width <= 0 || editorRect.height <= 0) {
      caret.style.display = "none";
      return;
    }
    const anchor = selection.anchorNode.nodeType === 1
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
    const line = anchor?.closest("p,li,[contenteditable=true]") ?? editor;
    const lineRect = line.getBoundingClientRect();
    const computed = getComputedStyle(line);
    const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.4 || 20;
    const glyphHeight = Math.max(12, Math.min(32, lineHeight * 0.8));
    const nativeRect = range.getClientRects()[0];
    const hasNativeRect =
      nativeRect &&
      nativeRect.x >= editorRect.left - 4 &&
      nativeRect.x <= editorRect.right + 4 &&
      nativeRect.y >= editorRect.top - 4 &&
      nativeRect.y <= editorRect.bottom + 4;
    // Chromium sometimes omits a collapsed range rectangle. Measure the
    // adjacent glyph rather than incorrectly drawing at the start of a line
    // when the user is editing text in the middle of a paragraph.
    let glyphRect = null;
    let afterGlyph = false;
    if (!hasNativeRect && selection.anchorNode.nodeType === 3) {
      const text = selection.anchorNode;
      const size = text.textContent?.length || 0;
      const offset = selection.anchorOffset;
      if (size > 0) {
        const probe = document.createRange();
        afterGlyph = offset > 0;
        probe.setStart(text, afterGlyph ? offset - 1 : 0);
        probe.setEnd(text, afterGlyph ? offset : 1);
        glyphRect = probe.getClientRects()[0] || null;
      }
    }
    const x = hasNativeRect
      ? nativeRect.x
      : glyphRect
        ? (afterGlyph ? glyphRect.right : glyphRect.left)
        : lineRect.left + (parseFloat(computed.paddingLeft) || 0);
    const referenceRect = hasNativeRect ? nativeRect : glyphRect;
    const top = referenceRect && referenceRect.height > 4
      ? referenceRect.top + (referenceRect.height - glyphHeight) / 2
      : lineRect.top + (lineRect.height - glyphHeight) / 2;
    if (
      !Number.isFinite(x) || !Number.isFinite(top) ||
      x < 0 || top < 0 || x > innerWidth || top + glyphHeight > innerHeight
    ) {
      caret.style.display = "none";
      return;
    }
    caret.style.left = Math.round(x) + "px";
    caret.style.top = Math.round(top) + "px";
    caret.style.height = Math.round(glyphHeight) + "px";
    caret.style.backgroundColor = getComputedStyle(editor).caretColor || "currentColor";
    caret.style.display = "block";
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!caret.isConnected) document.documentElement.appendChild(caret);
      update();
    });
  }
  function reset() {
    blink.currentTime = 0;
    schedule();
  }
  for (const type of ["selectionchange", "focusin", "focusout", "pointerup", "keyup"]) {
    document.addEventListener(type, schedule, true);
  }
  document.addEventListener("input", reset, true);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);

  window[key] = { update: schedule };
  schedule();
  return true;
})()`;
