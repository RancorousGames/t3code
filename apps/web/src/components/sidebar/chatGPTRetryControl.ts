/** Executed inside the exact ChatGPT guest; the browser's disabled state is authoritative. */
export function operateChatGPTRetryControl(
  click: boolean,
): "ready" | "disabled" | "missing" | "clicked" {
  const main = document.querySelector("main,[role='main']") ?? document.body;
  if (!main) return "missing";
  const normalize = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
  const retry = Array.from(main.querySelectorAll<HTMLElement>('button,[role="button"]')).find(
    (button) => {
      const text = normalize(button.textContent);
      const label = normalize(button.getAttribute("aria-label"));
      return /^try again$/i.test(text) || /^try again$/i.test(label);
    },
  );
  if (!retry) return "missing";
  for (let element: Element | null = retry; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return "missing";
    if (
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.hasAttribute("inert") ||
      element.getAttribute("data-disabled") === "true" ||
      style.pointerEvents === "none" ||
      style.cursor === "not-allowed" ||
      element.getAttribute("aria-busy") === "true"
    )
      return "disabled";
    if (element === main) break;
  }
  if (retry.getClientRects().length === 0 || retry.matches(":disabled")) return "disabled";
  if (!click) return "ready";
  retry.click();
  return "clicked";
}
