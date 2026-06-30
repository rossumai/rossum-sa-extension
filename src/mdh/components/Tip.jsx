import { h } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';

// Immediate custom tooltip — replaces the native `title` attribute (which has a
// browser hover delay). On hover it positions a fixed popup from the trigger's
// bounding rect, so it appears instantly and is never clipped by scroll-container
// overflow (matches the .oc-tooltip approach already used in the Overview charts).
// `block` wraps a block-level child (e.g. a full-width mini chart) in a <div>
// so it keeps its width; otherwise an inline <span> wraps inline triggers.
export default function Tip({ text, block, children }) {
  const ref = useRef(null);
  const popRef = useRef(null);
  const [coords, setCoords] = useState(null);

  function show() {
    const el = ref.current;
    if (!el || !text) return;
    const r = el.getBoundingClientRect();
    setCoords({ x: r.left + r.width / 2, y: r.bottom + 6 });
  }
  function hide() { setCoords(null); }

  // Center under the trigger, then clamp horizontally to the viewport. Runs
  // before paint so there's no visible jump.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el || !coords) return;
    const pad = 8;
    const w = el.offsetWidth;
    const left = Math.max(pad, Math.min(coords.x - w / 2, window.innerWidth - w - pad));
    el.style.left = `${left}px`;
  }, [coords]);

  const Tag = block ? 'div' : 'span';
  return (
    <Tag ref={ref} class={`stats-tip-trigger${block ? ' is-block' : ''}`} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {coords && (
        <span ref={popRef} class="stats-tip-pop" style={{ left: `${coords.x}px`, top: `${coords.y}px` }}>{text}</span>
      )}
    </Tag>
  );
}
