import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { isImageMime } from '../assetKeys.js';
// This note is the only place a pasted file's failure is ever reported, and a failure with no
// detail tells the user something went wrong and nothing else.
import { message } from '../errorText.js';
import { noteWith, withFailure, type NoteFailures } from '../noteText.js';
import useFileDrop from '../hooks/useFileDrop.js';
import type { AssetRow } from '../assets.js';

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

// The Markdown a pasted or dropped file becomes: an image renders in place, anything else is a link
// the reader clicks to download (design 2026-08-24 §5.3). Called by the paste and drop path below —
// the repo's dead-code guard states in its own header that it cannot see an export used only by a
// test, so that is an invariant held here rather than one the gate holds.
export function referenceFor(key: string, name: string, mime: string): string {
  return `${isImageMime(mime) ? '!' : ''}[${name}](${key})`;
}

// One line for a whole batch, plus every failure still unacknowledged (`noteText.js` composes it).
// The note channel holds ONE message, so a failure must not be erased by a success that follows it —
// the same lesson as the panel's log cap. Not by a later file in the same batch, and not by a LATER
// BATCH either: each paste starts a fresh `added`, the store's chain makes batch A settle before
// batch B, so B's success would deterministically overwrite A's failure — and for an editor upload
// that note is the only record there is, because the panel's log never sees this path.
//
// The carrier itself is owned by whoever owns the note slot — SpecView — because DISMISSAL is the
// only evidence the reader ever saw one, and no batch can know that about the batch before it.
function noteFor(added: string[], failed: NoteFailures): string {
  return noteWith(added.length ? `Added ${added.join(', ')}` : '', failed);
}

/** What the editor needs of the asset store. There is exactly one instance (store.assets); it
 *  arrives as a prop so this component can be driven without it. */
export type EditorAssetStore = {
  upload: (f: File) => Promise<{ row: AssetRow; reused: boolean }>;
};

export default function SourceEditor({
  text = '',
  onChange,
  viewRef,
  assets,
  onNote,
  failures,
}: {
  text?: string;
  onChange?: (next: string) => void;
  viewRef?: { current: any };
  assets?: EditorAssetStore;
  onNote?: (msg: string) => void;
  /** The note slot's unacknowledged failures. Shared by every editor reporting into one note. */
  failures?: { current: NoteFailures };
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const onNoteRef = useRef(onNote);
  onNoteRef.current = onNote;
  // Every deliverable has its own editor and they all report into ONE note, so the failures have to
  // outlive this component's batch AND this component. The own ref is the standalone fallback:
  // nothing is shared when nothing was handed down.
  const ownFailures = useRef<NoteFailures>({ lines: [], hidden: 0 });
  const failuresRef = useRef<{ current: NoteFailures }>(failures || ownFailures);
  failuresRef.current = failures || ownFailures;
  // The view is destroyed while a file may still be uploading — a mode switch, a deliverable
  // removed from the list. Tracked in the mount effect's cleanup rather than inferred from
  // `view.current`, which the cleanup deliberately leaves alone.
  const live = useRef(false);
  // What this editor last knew the stored text to be. A store update that ORIGINATED here must not be
  // dispatched back into the document (it would move the cursor mid-typing); a genuinely external one
  // — a restore, an accepted Refine — must be.
  const seen = useRef(text);

  // Upload each file, THEN insert its reference — never the other way round. Deliverable text is
  // user data, and a reference to an asset that does not exist renders as the error pill for every
  // future reader, with nothing that ever cleans it up. Sequential, so the references land in the
  // order the files were given.
  //
  // There is deliberately NO busy guard here. `assets.ts` serializes `upload` on one promise chain,
  // and this is precisely why it lives there: the panel is the other caller, in another component,
  // which a guard here could never see — and awaiting that chain from inside a job on it deadlocks.
  //
  // Every value it reads is a ref, so the mount effect below can capture this once and stay correct.
  async function ingest(files: File[]) {
    const store = assetsRef.current;
    if (!store) return;
    const added: string[] = [];
    const held = failuresRef.current;
    const note = () => {
      if (onNoteRef.current) onNoteRef.current(noteFor(added, held.current));
    };
    for (const f of files) {
      let row: AssetRow;
      let reused: boolean;
      try {
        ({ row, reused } = await store.upload(f));
      } catch (err) {
        held.current = withFailure(held.current, `${f.name} could not be added: ${message(err)}`);
        note();
        continue;
      }
      // The file reached the organization whether or not the reference lands, so it is reported
      // either way — otherwise a mode switch mid-upload leaves an asset nobody was told about.
      added.push(reused ? `${row.key} (already published)` : row.key);
      const v = view.current;
      if (!live.current || !v) {
        note();
        continue;
      }
      // The SELECTION AS IT IS NOW, not an offset captured before the await: the second effect
      // replaces the whole document when the stored text changes under this editor (a restore, an
      // accepted Refine, the 600ms debounced round-trip), and CodeMirror throws on an out-of-range
      // position.
      const at = v.state.selection.main;
      const ref = referenceFor(row.key, row.name, row.mime);
      // The first lands exactly where the cursor is, so one screenshot pasted mid-sentence stays
      // mid-sentence; the rest of a batch each take their own line.
      const insert = added.length > 1 ? `\n${ref}` : ref;
      v.dispatch({
        changes: { from: at.from, to: at.to, insert },
        selection: { anchor: at.from + insert.length },
        userEvent: 'input.paste',
      });
      note();
    }
  }

  // The same hook the Assets tab uses, so the two drop targets cannot drift apart.
  const { dragging, handlers } = useFileDrop({ onFiles: (files) => void ingest([...files]) });

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
          // CodeMirror has its own paste and drop handling, and for a FILE it reads the bytes as
          // text and inserts that (@codemirror/view `handlers.drop` / `handlers.paste`). An
          // extension's handlers run BEFORE those built-ins and a preventDefault stops them, so
          // this claims the event — but only when it actually carries files: a plain text paste,
          // and dragging a selection inside the editor, must keep working exactly as they do.
          EditorView.domEventHandlers({
            paste: (event) => {
              const files = event.clipboardData && event.clipboardData.files;
              if (!files || !files.length) return false;
              event.preventDefault();
              void ingest([...files]);
              return true;
            },
            dragenter: (event) => {
              handlers.dragenter(event);
              return event.defaultPrevented;
            },
            dragover: (event) => {
              handlers.dragover(event);
              return event.defaultPrevented;
            },
            dragleave: (event) => {
              handlers.dragleave(event);
              return event.defaultPrevented;
            },
            drop: (event) => {
              handlers.drop(event);
              return event.defaultPrevented;
            },
          }),
        ],
      }),
    });
    view.current = v;
    live.current = true;
    if (viewRef) viewRef.current = v;
    return () => {
      live.current = false;
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

  return <div class={'fabry-spec-cm' + (dragging ? ' dragging' : '')} ref={host} />;
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
