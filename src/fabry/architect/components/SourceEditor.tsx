import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// One deliverable's Markdown source, with highlighting, inside the unified specification view.
//
// CONTENT HEIGHT, not a scrollable box: the page's own scroller owns the whole specification, so every
// editor grows to fit its document and none of them scrolls internally. MEASURED (2026-08-19) that this
// is both cheap and well-behaved — five editors of 700 lines mount in **70ms**, their inner scroll range
// is **0**, and CodeMirror still renders only what is visible (**79** line elements out of 3500), so a
// fast scroll stays light.
//
// What it does NOT give is trustworthy geometry for lines it has not rendered — see
// `scrollLineIntoView` at the bottom of this file, which is why navigation goes through CodeMirror's
// own scroll effect rather than arithmetic. (The mirror-measurement module written for the textarea
// version was deleted with it; it had the same estimation problem in a different shape.)
const light = HighlightStyle.define([
  { tag: tags.heading, color: '#1a1a24', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#4270db' },
  { tag: tags.url, color: '#4270db' },
  { tag: tags.monospace, color: '#c41a16' },
  { tag: [tags.list, tags.quote], color: '#7a7a8c' },
  { tag: tags.processingInstruction, color: '#7a7a8c' }, // markdown punctuation (#, *, -)
]);
const dark = HighlightStyle.define([
  { tag: tags.heading, color: '#e8e8ee', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#5db0d7' },
  { tag: tags.url, color: '#5db0d7' },
  { tag: tags.monospace, color: '#f29766' },
  { tag: [tags.list, tags.quote], color: '#9a9aac' },
  { tag: tags.processingInstruction, color: '#9a9aac' },
]);
function prefersDark() {
  try {
    return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

// No height and no min-height: the editor is as tall as its text, which is what makes the page scroll
// as one document. Gutters are hidden — a specification is prose, and line numbers beside every
// paragraph read as code.
const surface = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-primary)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'visible' },
  '.cm-gutters': { display: 'none' },
  '.cm-content': { padding: '0' },
  '.cm-line': { padding: '0' },
});

export default function SourceEditor({
  text = '',
  onChange,
  viewRef,
}: {
  text?: string;
  onChange?: (next: string) => void;
  viewRef?: { current: any };
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // What this editor last knew the stored text to be. A store update that ORIGINATED here must not be
  // dispatched back into the document (it would move the cursor mid-typing); a genuinely external one
  // — a restore, an accepted Refine — must be.
  const seen = useRef(text);

  useEffect(() => {
    const listener = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const next = u.state.doc.toString();
      seen.current = next;
      if (onChangeRef.current) onChangeRef.current(next);
    });
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          surface,
          syntaxHighlighting(prefersDark() ? dark : light),
          listener,
        ],
      }),
    });
    view.current = v;
    if (viewRef) viewRef.current = v;
    return () => {
      v.destroy();
      if (viewRef && viewRef.current === v) viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || text === seen.current) return;
    seen.current = text;
    const cur = v.state.doc.toString();
    if (cur !== text) v.dispatch({ changes: { from: 0, to: cur.length, insert: text } });
  }, [text]);

  return <div class="fabry-spec-cm" ref={host} />;
}

// Put a source LINE at the top of the page's scroller.
//
// Two phases, and both are necessary. CodeMirror estimates the height of lines it has not rendered and
// the estimate assumes ONE visual line, so in wrapped prose an unvisited region undershoots by
// thousands of pixels — arithmetic from `lineBlockAt` lands nowhere near (measured: clicking a heading
// 500 lines down arrived at the section start). CodeMirror's OWN `scrollIntoView` copes, because it
// re-measures as it goes, and — verified — it scrolls the ANCESTOR scroller when the editor itself has
// no scroll range. That gets the line on screen but not reliably at the top, so once it is rendered
// `coordsAtPos` gives an exact answer and one correction finishes the job.
export function scrollLineIntoView(view: any, lineIndex: number, scroller: any, inset = 44) {
  if (!view || !scroller) return false;
  const doc = view.state.doc;
  const line = doc.line(Math.max(1, Math.min(doc.lines, lineIndex + 1)));
  view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: inset }) });
  requestAnimationFrame(() => {
    const coords = view.coordsAtPos(line.from);
    if (!coords) return;
    const delta = coords.top - scroller.getBoundingClientRect().top - inset;
    if (Math.abs(delta) > 2) scroller.scrollTop += delta;
  });
  return true;
}
