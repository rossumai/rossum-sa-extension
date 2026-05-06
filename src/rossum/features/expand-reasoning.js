export function handleNode(node) {
  const selector = 'button[data-sentry-source-file="ReasoningTiles.tsx"]';
  const buttons = node.matches?.(selector)
    ? [node]
    : Array.from(node.querySelectorAll(selector));
  for (const button of buttons) {
    if (button.textContent.trim() !== 'Show options') continue;
    // Click once per element — see expand-formulas.js for the same rationale.
    if (button.dataset.saExpanded) continue;
    button.dataset.saExpanded = '1';
    button.click();
  }
}
