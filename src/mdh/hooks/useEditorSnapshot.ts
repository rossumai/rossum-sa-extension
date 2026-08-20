import { useState, useRef, useEffect } from 'preact/hooks';

const DEBOUNCE_MS = 250;

/** The editor handle DataPanel passes: a ref to something that can read its text. */
export type EditorHandle = { getValue: () => string };

export type Snapshot = { text: string } & Record<string, unknown>;

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
export function useEditorSnapshot(
  editorRef: { current: EditorHandle | null },
  computeFn: (text: string) => Record<string, unknown>,
): [Snapshot, () => void] {
  const [snapshot, setSnapshot] = useState<Snapshot>({ text: '', placeholders: [], parsed: null });
  const timerRef = useRef<number | null>(null);

  function recompute(): void {
    clearTimeout(timerRef.current as number);
    timerRef.current = setTimeout(() => {
      if (!editorRef.current) return;
      const text = editorRef.current.getValue();
      setSnapshot({ text, ...computeFn(text) });
    }, DEBOUNCE_MS);
  }

  // Seed the snapshot from the editor's content on mount. The editor's text isn't
  // reactive, and a programmatic setValue that writes text byte-identical to what's
  // already there fires no CodeMirror change event — the default-pipeline load does
  // exactly this (DataPanel.syncPipeline writes the same default text the editor was
  // created with; see editorDiff.computeMinimalChange returning null for equal
  // strings). Without this seed nothing would ever call recompute() on that path, so
  // editorState.text would stay '' and everything keyed off it (the Variables inputs,
  // the Pipeline Debug) would never appear until the first real edit. Debounced like
  // every other recompute, so it lands after the consumer's mount effects settle the
  // initial text (no flash of stale default when a saved/external pipeline loads, and
  // it no-ops harmlessly if the editor isn't mounted yet).
  useEffect(() => {
    recompute();
    return () => clearTimeout(timerRef.current as number);
  }, []);

  return [snapshot, recompute];
}
