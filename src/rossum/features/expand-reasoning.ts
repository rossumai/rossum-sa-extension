import { trackOnce } from '../../usage/track.js';

export function handleNode(node: HTMLElement): void {
  const selector = 'button[data-sentry-source-file="ReasoningTiles.tsx"]';
  const buttons = node.matches?.(selector)
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>(selector));
  for (const button of buttons) {
    if (button.textContent.trim() !== 'Show options') continue;
    // Click once per element — see expand-formulas.js for the same rationale.
    if (button.dataset.saExpanded) continue;
    button.dataset.saExpanded = '1';
    button.click();
    trackOnce('sa_rossum_expand_reasoning');
  }
}
