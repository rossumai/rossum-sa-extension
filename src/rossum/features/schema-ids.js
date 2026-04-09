export function handleNode(node) {
  if (node.hasAttribute('data-sa-extension-schema-id')) {
    const span = document.createElement('span');
    span.className = 'rossum-sa-extension-schema-id';
    span.textContent = node.getAttribute('data-sa-extension-schema-id');
    node.appendChild(span);
  }
}
