import { trackOnce } from '../../usage/track.js';

export function init() {
  const style = document.createElement('style');
  style.textContent = `
[data-sa-extension-schema-id] {
  position: relative;
}

.rossum-sa-extension-schema-id {
  position: absolute;
  top: 2px;
  right: 2px;
  font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Roboto Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  letter-spacing: 0.01em;
  color: rgba(190, 40, 70, 0.6);
  background-color: rgba(255, 255, 255, 0.75);
  padding: 1px 4px;
  border-radius: 4px;
  opacity: 0.85;
  z-index: 100;
  pointer-events: auto;
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease, background-color 0.15s ease, font-size 0.15s ease, box-shadow 0.15s ease;
}

.rossum-sa-extension-schema-id:hover {
  opacity: 1;
  font-size: 11px;
  color: rgba(190, 40, 70, 1);
  background-color: rgba(255, 255, 255, 0.98);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12);
  z-index: 9999;
}`;
  document.head?.appendChild(style);
}

export function handleNode(node) {
  if (node.hasAttribute('data-sa-extension-schema-id')) {
    if (node.querySelector(':scope > .rossum-sa-extension-schema-id') != null) return;
    const id = node.getAttribute('data-sa-extension-schema-id');
    const span = document.createElement('span');
    span.className = 'rossum-sa-extension-schema-id';
    span.textContent = id;
    span.title = 'Click to copy';
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard.writeText(id).then(() => {
        const original = span.textContent;
        span.textContent = '✓ copied';
        setTimeout(() => { span.textContent = original; }, 1000);
      });
    });
    node.appendChild(span);
    // Counted where the feature has demonstrably ACTED, not where it was merely
    // enabled. Enablement is NOT reported at all since the daily config snapshot
    // was deleted (2026-08-19), which makes this rule the only signal there is —
    // count on the draw, never on init. scroll-lock.js broke it and was fixed.
    trackOnce('sa_rossum_schema_ids');
  }
}
