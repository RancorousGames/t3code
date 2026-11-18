/** Runs only for a newly created T3 session, before or shortly after its first turn. */
async function initializeChatGPTHighEffort() {
  if (!["chatgpt.com", "chat.openai.com"].includes(location.hostname) ||
      !(location.pathname === "/" || /^\/c\/[0-9a-f-]{36}$/.test(location.pathname)))
    return { status: "not_ready" };
  const button = document.querySelector('button[aria-label="Select ChatGPT model"]');
  if (!button || !/6\s+(?:Instant|Medium|High)\b/.test(button.textContent ?? ""))
    return { status: "not_ready" };
  const generating = document.querySelector(
    '[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"]',
  );
  if (generating && !(generating as HTMLButtonElement).disabled) return { status: "not_ready" };
  if (button.getAttribute("data-selected-reasoning-effort") === "high")
    return { status: "already_high" };
  const key = Object.keys(button).find((name) => name.startsWith("__reactFiber$"));
  if (!key) return { status: "not_ready" };
  type Model = { slug: string; versionId: string; thinkingEffort?: string | null };
  type Fiber = {
    memoizedProps?: { selectedModel?: Model; onModelChange?: (model: Model) => boolean };
    return?: Fiber | null;
  };
  let fiber = Reflect.get(button, key) as Fiber | undefined;
  for (let i = 0; fiber && i < 90; i++, fiber = fiber.return ?? undefined) {
    const props = fiber.memoizedProps;
    if (props?.selectedModel?.versionId !== "6" || typeof props.onModelChange !== "function")
      continue;
    const accepted = props.onModelChange({
      ...props.selectedModel,
      slug: "gpt-6-thinking",
      thinkingEffort: "extended",
    });
    if (accepted !== true) return { status: "not_ready" };
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (button.getAttribute("data-selected-reasoning-effort") === "high")
        return { status: "changed" };
    }
    return { status: "not_ready" };
  }
  return { status: "not_ready" };
}

export const CHATGPT_NEW_SESSION_HIGH_EFFORT_EXPRESSION = `(${initializeChatGPTHighEffort.toString()})()`;

/** A successful React callback is not proof until the picker reports High. */
export async function ensureChatGPTHighEffort(
  evaluate: (expression: string) => Promise<unknown>,
): Promise<boolean> {
  const response = await evaluate(CHATGPT_NEW_SESSION_HIGH_EFFORT_EXPRESSION);
  return (
    response !== null &&
    typeof response === "object" &&
    "status" in response &&
    (response.status === "changed" || response.status === "already_high")
  );
}
