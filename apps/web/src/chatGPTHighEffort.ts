/** Runs only for a newly created T3 session, before or shortly after its first turn. */
async function initializeChatGPTHighEffort() {
  if (
    !["chatgpt.com", "chat.openai.com"].includes(location.hostname) ||
    !(location.pathname === "/" || /^\/c\/[0-9a-f-]{36}$/.test(location.pathname))
  )
    return { status: "not_ready" };
  const button = document.querySelector('button[aria-label="Select ChatGPT model"]');
  if (!(button instanceof HTMLButtonElement)) return { status: "not_ready" };
  const generating = document.querySelector(
    '[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"]',
  );
  if (generating && !(generating as HTMLButtonElement).disabled) return { status: "not_ready" };
  if (button.getAttribute("data-selected-reasoning-effort") === "high")
    return { status: "already_high" };
  // The picker exposes effort independently of model version (6, 6.2, etc.).
  // Use its visible Power keyboard control instead of guessing private model slugs.
  const lock = Symbol.for("t3.chatgpt.initialHighEffort");
  if (Reflect.get(window, lock) || button.getAttribute("aria-expanded") === "true")
    return { status: "not_ready" };
  Reflect.set(window, lock, true);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
  const power = () =>
    document.querySelector('[role="menuitem"][aria-label="Power"][data-reasoning-slider]');
  try {
    button.click();
    for (let i = 0; i < 10 && !power(); i++) await wait();
    for (let step = 0; step < 2; step++) {
      if (button.getAttribute("data-selected-reasoning-effort") === "high")
        return { status: "changed" };
      const item = power();
      const slider = item?.querySelector('[role="slider"][aria-valuemin="0"][aria-valuemax="2"]');
      const before = slider?.getAttribute("aria-valuenow");
      if (
        !item ||
        !slider ||
        (before !== "0" && before !== "1") ||
        item.getAttribute("aria-disabled") === "true" ||
        slider.closest('[aria-disabled="true"],[data-locked="true"]')
      )
        return { status: "not_ready" };
      item.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          code: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      for (
        let i = 0;
        i < 10 &&
        power()?.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") === before;
        i++
      )
        await wait();
    }
    return {
      status:
        button.getAttribute("data-selected-reasoning-effort") === "high" ? "changed" : "not_ready",
    };
  } finally {
    if (button.getAttribute("aria-expanded") === "true") {
      power()
        ?.closest('[role="menu"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      if (button.getAttribute("aria-expanded") === "true" && !power()) button.click();
    }
    Reflect.deleteProperty(window, lock);
  }
}

export const CHATGPT_NEW_SESSION_HIGH_EFFORT_EXPRESSION = `(${initializeChatGPTHighEffort.toString()})()`;

/** Confirm High from the picker before submitting the initial prompt. */
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
