export function init() {
  const style = document.createElement('style');
  style.textContent = `
[data-sa-extension-schema-id] {
  position: relative;
}

.rossum-sa-extension-schema-id {
  position: absolute;
  top: 0;
  right: 0;
  color: red;
  font-size: 10px;
  transition: all 0.25s ease-in-out;
  opacity: .7;
  margin-inline: 3px;
}

.rossum-sa-extension-schema-id:hover {
  font-size: 16px;
  opacity: 1;
  background-color: rgba(255, 255, 255, 0.7);
  border-radius: 3px;
  padding-inline: 3px;
}`;
  document.head?.appendChild(style);
}

export function handleNode(node) {
  if (node.hasAttribute('data-sa-extension-schema-id')) {
    const span = document.createElement('span');
    span.className = 'rossum-sa-extension-schema-id';
    span.textContent = node.getAttribute('data-sa-extension-schema-id');
    node.appendChild(span);
  }
}
