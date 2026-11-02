/**
 * Read-only inspection of a single attached ChatGPT guest's React state.
 *
 * ChatGPT does not expose MCP tool results through its rendered message DOM.
 * Some results are retained in React Fiber props/state, so look for a caller-
 * supplied random marker without reading private network APIs or modifying UI.
 * Return only booleans and structural counts, never conversation/tool contents.
 *
 * Serialized and evaluated inside the authenticated Electron <webview>.
 */
export function probeChatGPTToolDom(exactMarker?: string) {
  const prefix = /T3_SELF_[A-F0-9]{32}/;
  const valid = exactMarker === undefined || /^T3_SELF_[A-F0-9]{32}$/.test(exactMarker);
  if (!valid) return { supported: false, reason: "invalid_marker" };
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(location.hostname))
    return { supported: false, reason: "not_chatgpt" };

  // Rendered user prompts and assistant echoes are not evidence that an MCP
  // tool result belongs to this guest. The assistant-echo fallback validates
  // assistant messages separately; React proof is reserved for hidden data.
  if (exactMarker && document.body?.textContent?.includes(exactMarker))
    return { supported: true, markerFound: false, reason: "rendered_marker",
      reactRoots: 0, objectsInspected: 0, stringsInspected: 0, searchTruncated: false };

  const containsMarker = (s: string): boolean =>
    exactMarker !== undefined ? s.includes(exactMarker) : prefix.test(s);
  const roots: object[] = [];
  for (const el of document.querySelectorAll("*")) {
    for (const key of Object.keys(el)) {
      if (/^__react(Fiber|Container)\$/.test(key)) {
        const value = (el as unknown as Record<string, unknown>)[key];
        if (value && typeof value === "object") roots.push(value);
      }
    }
  }

  // Prioritize the newest conversation units and their ancestors. The generic
  // React root graph can otherwise exhaust its budget on unrelated sidebars.
  const recent = [...document.querySelectorAll(
    '[data-turn-key],[data-content-search-unit-key],[data-testid^="conversation-turn-"]',
  )].slice(-12);
  for (const node of recent) {
    let ancestor: Element | null = node;
    for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
      for (const key of Object.keys(ancestor)) {
        if (/^__react(Fiber|Container)\$/.test(key)) {
          const value = (ancestor as unknown as Record<string, unknown>)[key];
          if (value && typeof value === "object") roots.push(value);
        }
      }
    }
  }
  // A result can disappear from React state when ChatGPT compacts old turns.
  // A negative scan is NOT evidence of absence; the caller may use the older
  // visible-assistant proof when the DOM inspection is inconclusive.
  const stack: Array<{ value: unknown; depth: number }> = roots.map((value) => ({
    value,
    depth: 0,
  }));
  const seen = new WeakSet<object>();
  let objectsInspected = 0;
  let stringsInspected = 0;
  let reactMarkerFound = false;
  let truncation = false;
  const startedAt = performance.now();
  while (stack.length > 0) {
    if (objectsInspected >= 150000 || performance.now() - startedAt > 1500) {
      truncation = true;
      break;
    }
    const current = stack.pop()!;
    const value = current.value;
    if (typeof value === "string") {
      stringsInspected++;
      if (containsMarker(value)) {
        reactMarkerFound = true;
        break;
      }
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value) ||
        current.depth > 12 || value instanceof Node) continue;

    seen.add(value);
    objectsInspected++;
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      continue;
    }
    for (const descriptor of Object.values(descriptors)) {
      if ("value" in descriptor) stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return {
    supported: true,
    markerFound: reactMarkerFound,
    reactRoots: roots.length,
    objectsInspected,
    stringsInspected,
    searchTruncated: truncation || (reactMarkerFound && stack.length > 0),
  };
}
