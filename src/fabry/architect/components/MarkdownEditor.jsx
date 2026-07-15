import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

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
  try { return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}
const surface = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-primary)', fontSize: '12px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-gutters': { display: 'none' },
  '.cm-content': { padding: '10px 0' },
});

export default function MarkdownEditor({ value = '', onChange, editorRef }) {
  const host = useRef(null);
  const view = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged && onChangeRef.current) onChangeRef.current(u.state.doc.toString());
    });
    const hl = syntaxHighlighting(prefersDark() ? dark : light);
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [basicSetup, markdown(), EditorView.lineWrapping, surface, hl, listener] }),
    });
    view.current = v;
    if (editorRef) editorRef.current = {
      getValue: () => v.state.doc.toString(),
      setValue: (text) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }),
      // CodeMirror mis-measures when revealed from a hidden (display:none) container
      // (e.g. the Architect Edit/Preview toggle) — call after un-hiding.
      refresh: () => { try { view.current?.requestMeasure(); } catch {} },
    };
    return () => v.destroy();
  }, []);

  // Value-prop is a seed AND an external-switch sync (opening a different
  // deliverable). Only dispatch when the incoming value truly differs from the
  // current doc, so typing (which flows out via onChange) is never clobbered.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (value !== cur) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  return <div class="fabry-arch-md" ref={host} />;
}
