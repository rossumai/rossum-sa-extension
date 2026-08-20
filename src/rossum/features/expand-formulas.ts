import { trackOnce } from '../../usage/track.js';

export function handleNode(node: HTMLElement): void {
  const buttons = node.matches?.('button[aria-label="Show source code"]')
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>('button[aria-label="Show source code"]'));
  for (const button of buttons) {
    // Click once per element. If Rossum re-renders this button (e.g. after
    // toggling a parent), our MutationObserver visits it again — without this
    // guard, the second click would toggle the just-expanded panel back off.
    if (button.dataset.saExpanded) continue;
    button.dataset.saExpanded = '1';
    button.click();
    trackOnce('sa_rossum_expand_formulas');
  }
}
