// src/ui/FabryMark.tsx
// The shared "Mr. Fabry" identity mark: a filled four-point star. One source of
// truth for every in-app Fabry surface (chat, audit, inspector, MDH input, the
// Console rail). Fill is `currentColor` (via .fabry-mark in console.css), so the
// mark inherits each surface's color — including the rail's white-when-active.
// `animated` (default) adds a slow blue→indigo→violet color cycle; the rail passes
// animated={false} for a static mark. Colors + reduced-motion handling live in CSS.
import { h } from 'preact';
import styles from './FabryMark.module.css';

// The canonical Fabry star: a filled four-point star at a "fuller" weight (inner
// radius ~4.8) chosen to match the previous ✦ brand glyph — not the slimmer path the
// old Rail SVG used. One constant drives every surface (chat, audit, inspector, rail).
const STAR_PATH = 'M12 2.5L15.4 8.6L21.5 12L15.4 15.4L12 21.5L8.6 15.4L2.5 12L8.6 8.6Z';

export default function FabryMark(
  { size = '1em', animated = true, class: className, title }:
  { size?: string | number; animated?: boolean; class?: string; title?: string },
) {
  const cls =
    styles.mark +
    (animated ? ' ' + styles.animated : '') +
    (className ? ' ' + className : '');
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
    >
      {title ? <title>{title}</title> : null}
      <path d={STAR_PATH} />
    </svg>
  );
}
