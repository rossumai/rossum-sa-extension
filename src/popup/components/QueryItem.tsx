import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { STATUS_GLYPH } from '../mdh-provenance.js';
import { placeHint } from '../hintPlacement.js';

let hintSeq = 0;

function CopyIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function OpenExternalIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}

export default function QueryItem({
  index,
  label,
  status,
  onCopy,
  onOpen,
}: {
  index: number;
  label: string;
  status?: { status?: string; hint?: string } | null;
  onCopy: () => void | Promise<void>;
  onOpen: () => void;
}) {
  const meta = STATUS_GLYPH[status?.status as string] || STATUS_GLYPH.pending;
  const hint = status?.hint;
  const hasHint = !!(meta.showHint && hint);

  // The hint used to render as a full-width line INSIDE this <li>, which grew the
  // row by one to several lines the moment a replay resolved — the layout shift.
  // It now lives in a hover/focus popover anchored to the status dot, so a query
  // row is exactly one line high from first paint and never changes.
  const [tip, setTip] = useState<{ top: number; left: number; placed: boolean } | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const hintId = useRef(`mdh-qhint-${++hintSeq}`);

  const openTip = () => {
    if (!hasHint) return;
    // Two passes: mount hidden to measure the tip, then place it. A tooltip's
    // size depends on how the text wraps, so it cannot be computed in advance.
    setTip({ top: 0, left: 0, placed: false });
  };
  const closeTip = () => setTip(null);

  useEffect(() => {
    if (!tip || tip.placed) return undefined;
    const a = dotRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a || !t) return undefined;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    const pos = placeHint(a, { width: t.width, height: t.height }, { width: vw, height: vh });
    // Functional update, and it is load-bearing: this effect runs after paint,
    // so the pointer can leave (or Escape can fire) between the tip mounting and
    // this measuring pass. A plain setTip() would then resurrect a tooltip the
    // user has already dismissed — and since nothing would close it again, it
    // would sit there permanently. Only place a tip that is still open.
    setTip((cur) => (cur && !cur.placed ? { ...pos, placed: true } : cur));
    return undefined;
  }, [tip]);

  // A fixed popover does not travel with its anchor, so close it if anything
  // scrolls or the window resizes rather than leaving it stranded mid-panel.
  useEffect(() => {
    if (!tip) return undefined;
    const close = () => setTip(null);
    const onKey = (e: any) => {
      if (e.key === 'Escape') setTip(null);
    };
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [!!tip]);

  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(flashTimer.current as any), []);

  const handleCopy = async (e: any) => {
    e.preventDefault();
    try {
      await onCopy();
      setCopyFailed(false);
      setCopied(true);
      clearTimeout(flashTimer.current as any);
      flashTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopyFailed(true);
    }
  };

  const handleOpen = (e: any) => {
    e.preventDefault();
    onOpen();
  };

  const liClass = [
    'mdh-q',
    status?.status === 'winner' ? 'mdh-q--winner' : '',
    status?.status === 'skipped' ? 'mdh-q--skipped' : '',
    status?.status === 'gated' ? 'mdh-q--gated' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li class={liClass}>
      <span
        ref={dotRef}
        class={`mdh-q-status ${meta.cls}${hasHint ? ' mdh-q-status--hinted' : ''}`}
        // No native `title` when a popover carries the hint — two tooltips for
        // one element is worse than either alone.
        title={hasHint ? undefined : meta.title}
        tabIndex={hasHint ? 0 : undefined}
        aria-describedby={tip ? hintId.current : undefined}
        onMouseEnter={openTip}
        onMouseLeave={closeTip}
        onFocus={openTip}
        onBlur={closeTip}
      >
        {meta.glyph}
      </span>
      <span class="mdh-q-num">{index + 1}.</span>
      <span class="mdh-q-name" title={label}>
        {label}
      </span>
      <span class="mdh-q-actions">
        <button
          type="button"
          class={`mdh-q-copy mdh-q-action${copied ? ' mdh-q-copy--ok' : ''}`}
          title={
            copyFailed
              ? 'Copy failed — clipboard blocked'
              : 'Copy pipeline (with current row values) to clipboard'
          }
          onClick={handleCopy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button
          type="button"
          class="mdh-q-open mdh-q-action"
          title="Open in Dataset Management with this pipeline prefilled"
          onClick={handleOpen}
        >
          <OpenExternalIcon />
        </button>
      </span>
      {tip ? (
        <span
          ref={tipRef}
          id={hintId.current}
          role="tooltip"
          class={`mdh-q-hint${status?.status === 'error' ? ' mdh-q-hint--error' : ''}`}
          style={{
            top: `${tip.top}px`,
            left: `${tip.left}px`,
            visibility: tip.placed ? 'visible' : 'hidden',
          }}
        >
          <span class="mdh-q-hint-title">{meta.title}</span>
          {hint}
        </span>
      ) : null}
    </li>
  );
}
