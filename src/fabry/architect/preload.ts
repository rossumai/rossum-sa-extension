// Warm every deliverable's rendered document in idle time, so switching is instant
// (owner, 2026-08-18).
//
// Deliberately NOT eager-on-load-everything-at-once: rendering N documents synchronously would
// block the first paint of the one the user is actually looking at, which is the opposite of the
// goal. One document per idle slice, the ACTIVE one skipped (it renders itself on mount), and
// anything already cached skipped too.
//
// The diagram bundle is loaded FIRST when any deliverable needs it, because a document rendered
// before it arrives caches with code fences where diagrams belong — the cache key encodes that,
// so it would simply be re-rendered later and the preload wasted.
import { renderDocument, isRendered } from '../../docs/renderCache.js';
import { getMermaidRenderer, loadMermaidRenderer } from '../../ui/fabry/mermaidLoader.js';
import type { SpecDoc } from '../../docs/specDocument.js';

export const MERMAID_FENCE = /^[ \t]*```[ \t]*mermaid[ \t]*$/m;
// A guard, not a policy: a specification of tens of documents is normal, thousands is not, and
// an unbounded background loop on a pathological list is worse than an incomplete preload.
export const PRELOAD_CAP = 40;

type IdleDeps = { requestIdleCallback?: any; cancelIdleCallback?: any };
type IdleHandle = { id: any; idle: boolean };

function idle(fn: () => void, deps: IdleDeps): IdleHandle {
  const ric = deps && deps.requestIdleCallback;
  if (typeof ric === 'function') return { id: ric(fn, { timeout: 500 }), idle: true };
  return { id: setTimeout(fn, 16), idle: false };
}

function cancelIdle(handle: IdleHandle | null, deps: IdleDeps) {
  if (!handle) return;
  const cic = deps && deps.cancelIdleCallback;
  if (handle.idle && typeof cic === 'function') cic(handle.id);
  else clearTimeout(handle.id);
}

// Returns a cancel function. `dark` and `syncLines` must match what the pane will ask for, or the
// warmed entry is keyed differently and never read.
export function preloadDeliverables({
  deliverables = [],
  activeId = null,
  dark = false,
  syncLines = true,
  cap = PRELOAD_CAP,
  deps = typeof window !== 'undefined' ? window : {},
}: {
  deliverables?: SpecDoc[];
  activeId?: string | null;
  dark?: boolean;
  syncLines?: boolean;
  cap?: number;
  deps?: IdleDeps;
} = {}) {
  const queue = deliverables
    .filter((d) => d && d.id !== activeId && typeof d.text === 'string' && d.text.trim())
    .slice(0, cap);
  if (!queue.length) return () => {};

  let cancelled = false;
  let handle: IdleHandle | null = null;

  // Two passes, because waiting for the diagram bundle before warming ANYTHING would mean no
  // preload at all until 1.5MB has loaded — and most documents have no diagram. Plain documents
  // warm straight away; the ones with a fence wait, since a document rendered before the bundle
  // arrives caches with code fences where diagrams belong (the key encodes that, so it would be
  // re-rendered later and the work wasted).
  const plain = queue.filter((d) => !MERMAID_FENCE.test(d.text!));
  const diagrams = queue.filter((d) => MERMAID_FENCE.test(d.text!));

  const warm = (d: SpecDoc) => {
    const mermaid = getMermaidRenderer();
    if (isRendered({ id: d.id, text: d.text, dark, syncLines, mermaid })) return;
    try {
      renderDocument({ id: d.id, text: d.text, mermaid, dark, syncLines });
    } catch {
      /* one bad document must not stop the queue */
    }
  };

  const drain = (list: SpecDoc[], done?: () => void) => {
    const step = () => {
      if (cancelled) return;
      const next = list.shift();
      if (next) warm(next);
      if (list.length && !cancelled) handle = idle(step, deps);
      else if (done && !cancelled) done();
    };
    handle = idle(step, deps);
  };

  const afterPlain = () => {
    if (cancelled || !diagrams.length) return;
    if (getMermaidRenderer()) {
      drain(diagrams);
      return;
    }
    // Load once, then warm the diagram documents; a failed load still warms them (as fences),
    // because a visible document beats an empty pane.
    loadMermaidRenderer().then(
      () => {
        if (!cancelled) drain(diagrams);
      },
      () => {
        if (!cancelled) drain(diagrams);
      },
    );
  };

  if (plain.length) drain(plain, afterPlain);
  else afterPlain();

  return () => {
    cancelled = true;
    cancelIdle(handle, deps);
  };
}
