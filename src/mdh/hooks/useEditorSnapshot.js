import { useState, useRef, useEffect } from 'preact/hooks';

const DEBOUNCE_MS = 250;

// Keeps a debounced, reactive snapshot of the (non-reactive) editor contents.
//
// The pipeline editor is a CodeMirror instance whose text isn't a signal, so
// anything derived from it at render time (the Variables inputs, the Pipeline
// Debug) only refreshes when the component happens to re-render. Editing the
// pipeline to invalid JSON — which is exactly what an unfilled bare `{name}`
// placeholder does — never triggered a re-render, so the inputs never appeared
// and the debug vanished. This hook fixes that: call `recompute()` on every
// editor change (valid or not) and on placeholder changes; after a short
// debounce it reads the editor and stores `{ text, ...computeFn(text) }`,
// re-rendering the consumer. Debounced so the debug doesn't re-run its
// per-stage aggregations on every keystroke.
//
// Returns `[snapshot, recompute]`.
export function useEditorSnapshot(editorRef, computeFn) {
  const [snapshot, setSnapshot] = useState({ text: '', placeholders: [], parsed: null });
  const timerRef = useRef(null);

  function recompute() {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!editorRef.current) return;
      const text = editorRef.current.getValue();
      setSnapshot({ text, ...computeFn(text) });
    }, DEBOUNCE_MS);
  }

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return [snapshot, recompute];
}
