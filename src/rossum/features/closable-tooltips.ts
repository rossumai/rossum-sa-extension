import { track } from '../../usage/track.js';

const STYLE_ID = 'rossum-sa-extension-closable-tooltips-style';
const BUTTON_CLASS = 'rossum-sa-extension-tooltip-close';
const FLAG = '__saTooltipCloseAttached';
const POPPER_SELECTOR = '.MuiTooltip-popperInteractive';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function init() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${BUTTON_CLASS} {
  width: 18px;
  height: 18px;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font: inherit;
  line-height: 1;
}

.${BUTTON_CLASS}:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.18);
}

.${BUTTON_CLASS} svg {
  width: 10px;
  height: 10px;
  display: block;
}`;
  (document.head || document.documentElement)?.appendChild(style);

  // Cover poppers already present at script start (rare, but free safety).
  for (const popper of document.querySelectorAll(POPPER_SELECTOR) as NodeListOf<HTMLElement>) {
    addCloseButton(popper);
  }
}

export function handleNode(node: HTMLElement): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  // Match either the popper itself OR any descendant added in a later mutation
  // (when MUI adds the popper first and fills its content in a follow-up commit).
  const popper =
    node.matches?.(POPPER_SELECTOR)
      ? node
      : node.closest?.(POPPER_SELECTOR);
  if (popper) addCloseButton(popper as HTMLElement);
}

function addCloseButton(popper: HTMLElement) {
  if ((popper as any)[FLAG]) return;
  const tooltip = popper.querySelector(':scope > .MuiTooltip-tooltip') as HTMLElement | null;
  if (!tooltip) return;
  (popper as any)[FLAG] = true;

  tooltip.style.position = 'relative';
  tooltip.style.paddingRight = '24px';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BUTTON_CLASS;
  btn.setAttribute('aria-label', 'Close tooltip');
  btn.title = 'Close';
  btn.style.position = 'absolute';
  btn.style.top = '2px';
  btn.style.right = '2px';

  // Build the SVG via DOM APIs (no innerHTML) so a strict Trusted Types policy
  // on the host page can't block the icon from rendering.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1.5 1.5l7 7M8.5 1.5l-7 7');
  svg.appendChild(path);
  btn.appendChild(svg);

  btn.addEventListener('click', (e) => {
    // A real dismissal, so every one counts (not trackOnce): the count IS the
    // signal for whether this always-on feature earns its keep.
    track('sa_rossum_tooltip_close');
    e.stopPropagation();
    e.preventDefault();
    popper.style.display = 'none';
  });
  btn.addEventListener('mousedown', (e) => e.stopPropagation());

  tooltip.appendChild(btn);
}
