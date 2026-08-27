// A file drop target: the four drag events, the nesting counter that keeps the highlight steady,
// and the one rule that separates a file drop from every other drag.
//
// Extracted when the Architect gained its second drop target (the Assets tab and the source
// editor). `src/mdh/components/FileDropArea.tsx` carries the same behaviour and is deliberately NOT
// reused: it is single-file (`onFile(files[0])`) and click-anywhere-to-open, both wrong here.
//
// The handlers are DOM-level, not JSX props, because the two call sites attach them differently:
// the panel spreads them onto a `<div>`, and the editor hands them to
// `EditorView.domEventHandlers`, whose keys are DOM event names.
import { useRef, useState } from 'preact/hooks';

// Only drags carrying FILES are ours — a deliverable dragged in the sidebar, or a selection dragged
// inside the editor, must not read as an upload.
function hasFiles(e: any): boolean {
  const types = e && e.dataTransfer && e.dataTransfer.types;
  return !!types && [...types].includes('Files');
}

export type FileDropHandlers = {
  dragenter: (e: any) => void;
  dragover: (e: any) => void;
  dragleave: (e: any) => void;
  drop: (e: any) => void;
};

export default function useFileDrop(opts: {
  onFiles: (files: FileList) => void;
  /** False turns the target down: it still swallows the drop, and `onRefused` says why. */
  enabled?: boolean;
  onRefused?: () => void;
}): { dragging: boolean; handlers: FileDropHandlers } {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const latest = useRef(opts);
  latest.current = opts;
  // Two mechanisms, and they carry different weight.
  //
  // `latest.current` is the load-bearing one. CodeMirror takes its handlers when the view is
  // constructed — inside SourceEditor's mount effect, which runs once — so whatever set it holds is
  // the set it holds for life, and reading `opts` through the closure would freeze the first
  // render's `enabled` and `onFiles`. Pinned by "turns the drop target down when the index goes bad
  // while the panel is open" (architect-assets-panel-view.test.tsx).
  //
  // `built.current` gives the set a stable identity, and no call site observes that today: with
  // `latest` in place, rebuilding it every render behaves identically (measured — the whole suite
  // stays green). It is kept so there is ONE handler set with ONE source of options, which is what
  // makes the paragraph above true of every call site rather than of the editor alone.
  const built = useRef<FileDropHandlers | null>(null);
  if (!built.current) {
    const off = () => latest.current.enabled === false;
    built.current = {
      dragenter(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        if (!off()) setDragging(true);
      },
      dragover(e) {
        if (!hasFiles(e)) return;
        // preventDefault even while turned down: without it the browser stops firing `drop` here
        // and NAVIGATES to the dropped file instead, which loses the Architect's unsaved state.
        // The refusal belongs in `drop`, where it can say why.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = off() ? 'none' : 'copy';
      },
      dragleave(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      drop(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setDragging(false);
        const { onFiles, onRefused } = latest.current;
        if (off()) {
          if (onRefused) onRefused();
          return;
        }
        onFiles(e.dataTransfer.files);
      },
    };
  }
  return { dragging, handlers: built.current };
}
