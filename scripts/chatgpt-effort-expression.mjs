/** Set an existing ChatGPT conversation's effort through its mounted React model handler. */
export function chatGPTEffortExpression(level) {
  const targets = {
    instant: { slug: "gpt-6", thinkingEffort: undefined, uiEffort: "none" },
    medium: { slug: "gpt-6-thinking", thinkingEffort: "standard", uiEffort: "medium" },
    high: { slug: "gpt-6-thinking", thinkingEffort: "extended", uiEffort: "high" },
  };
  if (!Object.hasOwn(targets, level)) throw new Error("Effort must be instant, medium or high.");
  const target = targets[level];
  return `(async () => {
    const button = document.querySelector('button[aria-label="Select ChatGPT model"]');
    if (!button || !/6\\s+(?:Instant|Medium|High)\\b/.test(button.textContent ?? ''))
      return { error: 'GPT-6 reasoning picker unavailable.' };
    const before = button.getAttribute('data-selected-reasoning-effort');
    let fiber = button[Object.keys(button).find(key => key.startsWith('__reactFiber$'))];
    let changeModel;
    let previousModel;
    for (let i = 0; fiber && i < 90; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (typeof props?.onModelChange === 'function' && props.selectedModel?.versionId === '6') {
        changeModel = props.onModelChange;
        previousModel = props.selectedModel;
        break;
      }
    }
    if (!changeModel) return { error: 'ChatGPT model selection handler unavailable.' };
    const target = ${JSON.stringify({slug:target.slug,thinkingEffort:target.thinkingEffort})};
    const expectedUiEffort = ${JSON.stringify(target.uiEffort)};
    const targetModel = { ...previousModel, slug: target.slug, thinkingEffort: target.thinkingEffort };
    if (before !== expectedUiEffort) {
      if (changeModel(targetModel) !== true)
        return { error: 'ChatGPT rejected model selection.' };
    }
    // Escape dismisses an already-open Radix picker; there is no confirm button.
    if (document.querySelector('[role="slider"][aria-valuemax="2"]'))
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
      }));
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (button.getAttribute('data-selected-reasoning-effort') === expectedUiEffort &&
          !document.querySelector('[role="slider"][aria-valuemax="2"]'))
        return { level: ${JSON.stringify(level)}, changed: before !== expectedUiEffort, dialogClosed: true };
    }
    return { error: 'Effort was not confirmed or dialog remains open.',
      selected: button.getAttribute('data-selected-reasoning-effort'),
      dialogOpen: !!document.querySelector('[role="slider"][aria-valuemax="2"]') };
  })()`;
}
