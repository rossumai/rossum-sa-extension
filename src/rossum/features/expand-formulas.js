export function handleNode(node) {
  const buttons = node.matches?.('button[aria-label="Show source code"]')
    ? [node]
    : Array.from(node.querySelectorAll('button[aria-label="Show source code"]'));
  for (const button of buttons) {
    button.click();
  }
}
