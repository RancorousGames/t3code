/** Change one existing ChatGPT conversation's GPT-6 effort through its mounted picker. */
export function chatGPTEffortExpression(level) {
  const index = { instant: 0, medium: 1, high: 2 }[level];
  if (index === undefined) throw new Error('Effort must be instant, medium or high.');
  return `(async () => {
    const picker = document.querySelector('button[aria-label="Select ChatGPT model"]');
    if (!picker || !/6\\s+(?:Instant|Medium|High)\\b/.test(picker.textContent ?? ''))
      return { error: 'GPT-6 reasoning picker unavailable.' };
    const before = /6\\s+(Instant|Medium|High)\\b/.exec(picker.textContent ?? '')?.[1]?.toLowerCase();
    if (before === ${JSON.stringify(level)}) return { level: before, changed: false };
    const present = () => [...document.querySelectorAll('[role="slider"][aria-valuemin="0"][aria-valuemax="2"]')]
      .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    let slider = present();
    const opened = !slider;
    if (opened) picker.click();
    for (let i = 0; !slider && i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      slider = present();
    }
    if (!slider) return { error: 'Reasoning slider did not appear.' };
    const root = slider.parentElement?.parentElement;
    if (!root) return { error: 'Reasoning slider structure changed.' };
    const rect = root.getBoundingClientRect();
    const x = rect.left + 14 + (rect.width - 28) * (${index} / 2);
    const pointer = (type, buttons) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons, clientX: x, clientY: rect.top + rect.height / 2,
    });
    root.dispatchEvent(pointer('pointerdown', 1));
    root.dispatchEvent(pointer('pointerup', 0));
    let current = -1;
    for (let i = 0; i < 6; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      current = Number(present()?.getAttribute('aria-valuenow'));
      if (current === ${index}) break;
    }
    if (opened) picker.click();
    const selected = /6\\s+(Instant|Medium|High)\\b/.exec(picker.textContent ?? '')?.[1]?.toLowerCase();
    return selected === ${JSON.stringify(level)} && current === ${index}
      ? { level: selected, changed: true }
      : { error: 'Effort did not update.', selected, sliderValue: current };
  })()`;
}
