import { h } from 'preact';

const ITEMS = [
  ['Drag', 'Rotate'],
  ['Scroll', 'Zoom'],
  ['Right-drag', 'Pan'],
  ['Hover', 'Highlight links'],
  ['Click', 'Details'],
];

export default function NavGuide() {
  return (
    <div class="galaxy-help">
      <div class="galaxy-help-title">Navigate</div>
      {ITEMS.map(([k, v]) => (
        <div class="galaxy-help-row">
          <kbd>{k}</kbd>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
