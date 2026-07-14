import { h } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import styles from './Tip.module.css';

// Shared instant custom tooltip/popup (design system; promoted from MDH). Replaces
// the native `title` attribute (browser hover delay + no styling): on hover it
// positions a FIXED popup from the trigger's bounding rect, so it appears instantly
// and is never clipped by scroll-container overflow. Auto-flips ABOVE the trigger
// when there isn't room below (e.g. a control pinned to the bottom of the viewport).
// `text` may be a string OR a vnode (for richer content). `block` wraps a
// block-level child in a <div> so it keeps its width; otherwise an inline <span>.
export default function Tip({ text, block, children }) {
  const ref = useRef(null);
  const popRef = useRef(null);
  const [rect, setRect] = useState(null);

  function show() {
    const el = ref.current;
    if (!el || !text) return;
    const r = el.getBoundingClientRect();
    setRect({ cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  }
  function hide() { setRect(null); }

  // Center under (or over) the trigger, clamp horizontally to the viewport, and
  // flip above when there's no room below. Runs before paint so there's no jump.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el || !rect) return;
    const pad = 8;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const left = Math.max(pad, Math.min(rect.cx - w / 2, window.innerWidth - w - pad));
    const below = rect.bottom + 6 + hgt + pad <= window.innerHeight;
    const top = below ? rect.bottom + 6 : Math.max(pad, rect.top - 6 - hgt);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [rect]);

  const Tag = block ? 'div' : 'span';
  return (
    <Tag ref={ref} class={styles.trigger + (block ? ' ' + styles.block : '')} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {rect && (
        <span ref={popRef} class={styles.pop} style={{ left: `${rect.cx}px`, top: `${rect.bottom + 6}px` }}>{text}</span>
      )}
    </Tag>
  );
}
