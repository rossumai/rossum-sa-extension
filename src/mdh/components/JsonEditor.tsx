// src/mdh/components/JsonEditor.tsx
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  keymap,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  Decoration,
} from '@codemirror/view';
import { indentWithTab, history, defaultKeymap, historyKeymap } from '@codemirror/commands';
// We use the JavaScript grammar (a strict superset of JSON5) so that line and
// block comments inside prefilled templates are tokenized as comments instead
// of falling through as untagged text. JSON5.parse below still owns validation.
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  syntaxHighlighting,
  HighlightStyle,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
  foldKeymap,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import JSON5 from 'json5';
import { stageToggleGutter } from '../pipelineGutter.js';
import { stageLineRanges, entryIndexAtOffset } from '../pipelineComments.js';
import { operatorColonOffset } from '../stageLink.js';
import { computeMinimalChange } from '../editorDiff.js';
import { animateScrollTop, revealScrollTop } from '../smoothScroll.js';
import { makeCompletionSource } from '../pipelineCompletions.js';
// Re-exported for PipelineEditor.jsx / DataPanel.jsx, which import it from here.
export { extractFieldNames } from '../pipelineCompletions.js';

// Pure: is `text` acceptable for this editor instance? JSON5 everywhere; with
// `jsonLines` also accept NDJSON (every non-empty line is strict JSON on its
// own) — the clipboard import stage's Next path (getFormat('json').parse)
// accepts JSON-lines via an NDJSON fallback, so the editor's validation must
// not contradict it. Every other consumer (default jsonLines=false, incl. the
// pipeline editor) keeps strict JSON5-only behavior.
export function isAcceptable(text: string, { jsonLines = false }: { jsonLines?: boolean } = {}) {
  try {
    JSON5.parse(text);
    return true;
  } catch {
    /* fall through */
  }
  if (!jsonLines) return false;
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (!lines.length) return false;
  try {
    for (const l of lines) JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}

const darkQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : { matches: false };

const lightHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.string, color: '#22883e' },
    { tag: tags.number, color: '#b45309' },
    { tag: tags.bool, color: '#4270db' },
    { tag: tags.null, color: '#7a7a8c' },
    { tag: tags.propertyName, color: '#1a1a24' },
    { tag: [tags.lineComment, tags.blockComment], color: '#7a7a8c', fontStyle: 'italic' },
  ]),
);

const darkHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.string, color: '#34d058' },
    { tag: tags.number, color: '#f59e0b' },
    { tag: tags.bool, color: '#5b8af0' },
    { tag: tags.null, color: '#8888a0' },
    { tag: tags.propertyName, color: '#dddde8' },
    { tag: [tags.lineComment, tags.blockComment], color: '#8888a0', fontStyle: 'italic' },
  ]),
);

// The element that actually scrolls the editor. Prefers CodeMirror's own
// scroller when it has range, else the `.json-editor` container — see
// revealStage for why the distinction is load-bearing here. Picks whichever has
// the LARGER range rather than a bare `>` test: the measured layout sits exactly
// on that threshold, and line heights are fractional under lineWrapping while
// these properties are integer-rounded, so a sub-pixel rounding difference could
// otherwise hand it to a scroller with a ~1px range.
function scrollerFor(view: any, container: any) {
  const sc = view.scrollDOM;
  const scRange = sc ? sc.scrollHeight - sc.clientHeight : 0;
  const boxRange = container ? container.scrollHeight - container.clientHeight : 0;
  return boxRange > scRange ? container : sc || container;
}

// One-entry memo keyed on the CodeMirror Text object. `Text` is immutable, so
// identity implies identical content and a changed document is always a new
// object — the key cannot go stale. stageLineRanges() runs a whole-document
// JSON5 parse plus one per stage, and the pointer-hover handler below would
// otherwise pay for that on every mousemove.
let rangesMemoDoc: any = null;
let rangesMemoValue: any = null;
function stageRangesFor(state: any) {
  if (state.doc !== rangesMemoDoc) {
    rangesMemoDoc = state.doc;
    rangesMemoValue = stageLineRanges(state.doc.toString());
  }
  return rangesMemoValue;
}

// ── Linked-stage band ──────────────────────────────────────────────────────
// The tinted background behind the stage the Stages-view connector points at.
// Set from outside via editorRef.highlightStage(); see StageLinkOverlay.jsx.
const setLinkedStage = StateEffect.define(); // payload: entryIndex | null
const linkedLine = Decoration.line({ class: 'cm-linked-stage' });

// Pure (state only, no view): the line decorations for one top-level stage.
// Decoration.none for a null index, an index with no stage (the buffer doesn't
// parse, or an edit removed that stage), or a stage whose span sits outside the
// document. Line decorations rather than a range mark, so the band spans the
// full width and survives wrapped lines.
export function linkedStageDecos(state: any, entryIndex: number | null) {
  if (entryIndex == null) return Decoration.none;
  const r = stageLineRanges(state.doc.toString())[entryIndex];
  if (!r) return Decoration.none;
  const len = state.doc.length;
  const from = Math.max(0, Math.min(r.start, len));
  const to = Math.max(from, Math.min(r.end - 1, len)); // `end` is just past the '}'
  const out = [];
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) out.push(linkedLine.range(state.doc.line(n).from));
  return Decoration.set(out);
}

// Holds the highlighted stage's ENTRY INDEX — not a text range — and re-derives
// the band from the current document whenever the index or the document changes.
//
// Index-based is the right model here, not an accident: the source of truth is
// which Stages-view section the pointer is over, and that is an index. So an
// edit that adds or removes a stage keeps the band on the section being hovered
// rather than on the text that used to be there. It also sidesteps a trap —
// LineDecoration maps with MapMode.TrackBefore (@codemirror/view), so mapping
// the decorations through a change DROPS the band outright when the line break
// in front of it is deleted, and a mapped position is not necessarily at a line
// start. Re-deriving always yields whole lines of the stage that exists now.
//
// Cost: one stageLineRanges() parse per edit, and only while a stage is
// highlighted (i.e. while the pointer is over a section). The updateListener
// below already runs JSON5.parse on every docChanged, so this is the same order
// of work, not a new one.
const linkedStageField = StateField.define({
  create: () => ({ entryIndex: null, deco: Decoration.none }),
  update(value, tr) {
    let { entryIndex } = value;
    let dirty = false;
    for (const e of tr.effects) {
      if (!e.is(setLinkedStage)) continue;
      entryIndex = e.value;
      dirty = true;
    }
    if (tr.docChanged && entryIndex != null) dirty = true;
    if (!dirty) return value;
    return { entryIndex, deco: linkedStageDecos(tr.state, entryIndex) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const baseTheme = EditorView.theme({
  '&': { fontSize: '12px', flex: '1' },
  '.cm-scroller': {
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    overflow: 'auto',
  },
  '.cm-gutters': { border: 'none' },
});

const compactTheme = EditorView.theme({
  '&': { fontSize: '12px', flex: '1' },
  '.cm-scroller': {
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    overflow: 'auto',
  },
  '.cm-gutters': { display: 'none' },
  '.cm-content': { padding: '4px 0' },
  '&.cm-focused': { outline: 'none' },
});

// `basicSetup` minus the line-number and fold gutters. CodeMirror's docs say the
// way to customize basicSetup is to copy its array literal and adjust it, so the
// aggregate pipeline editor uses this: its only gutter is the stage enable/disable
// toggle — reclaiming horizontal space and removing the section-collapse (fold)
// button. CSS-hiding the gutters proved unreliable; not rendering them is robust.
const aggregateSetup = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

/** The imperative API JsonEditor publishes on its `editorRef`. This is the boundary between
 *  the editor and its six consumers (the pipeline editor, the two bulk modals, the record
 *  editor, and both index panels); before it was written down, every one of them held the
 *  handle as `any` and you had to read JsonEditor to learn what you could call. */
export type JsonEditorHandle = {
  getValue: () => string;
  /** Writes back as a MINIMAL change so a localized edit does not reset scroll — see the
   *  comment at the assignment. */
  setValue: (v: string) => void;
  isValid: () => boolean;
  getParsed: () => any;
  getError: () => string;
  /** The box that visually CLIPS the editor, or null before mount. */
  clipRect: () => { top: number; bottom: number; left: number; right: number } | null;
  focus: () => void;
  refresh: () => void;
  revealStage: (entryIndex: number) => void;
  /** Marks a stage in the editor to match the Stages-view connector; null clears it. */
  highlightStage: (entryIndex: number | null) => void;
  /** Viewport rect of the stage's opening `{`, plus `hEnd` (just past the operator) so a
   *  connector's first horizontal can clear it. null when the line is scrolled out. */
  stageScreenRect: (
    entryIndex: number,
  ) => { top: number; bottom: number; left: number; right: number; hEnd: number } | null;
};

export default function JsonEditor({
  value = '',
  onChange,
  onValidChange,
  onToggleStage,
  onCursorStage,
  onHoverStage,
  mode = 'default',
  fields,
  compact = false,
  readOnly = false,
  onSubmit,
  editorRef,
  minHeight = '200px',
  jsonLines = false,
}: {
  value?: string;
  onChange?: (next: string) => void;
  // Fires when the document becomes parseable. It carries NO payload: every call site
  // is `setTimeout(onValidChange, 500)` and all four consumers declare a zero-arg
  // handler, so the `valid` parameter it used to declare was never passed or read.
  onValidChange?: () => void;
  onToggleStage?: (i: number) => void;
  onCursorStage?: (i: number | null) => void;
  onHoverStage?: (i: number | null) => void;
  mode?: string;
  fields?: any;
  compact?: boolean;
  readOnly?: boolean;
  onSubmit?: () => void;
  editorRef?: { current: JsonEditorHandle | null };
  minHeight?: string;
  jsonLines?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onValidChangeRef = useRef(onValidChange);
  const onSubmitRef = useRef(onSubmit);
  const onToggleStageRef = useRef(onToggleStage);
  const onCursorStageRef = useRef(onCursorStage);
  const onHoverStageRef = useRef(onHoverStage);
  const lastHoverStageRef = useRef<number | null | undefined>(undefined);
  // undefined = nothing reported yet; null = reported as outside every stage.
  const lastCursorStageRef = useRef<number | null | undefined>(undefined);
  // Mirrors the other callback refs above: the CodeMirror view + its
  // updateListener are created once in the mount-only effect below, so any
  // prop the validators read there must be threaded through a ref that's
  // refreshed on every render (not captured at mount time) to avoid a
  // stale-closure hazard if the prop ever changes after mount. For the import
  // wizard's clipboard editor `jsonLines` is fixed for the component's
  // lifetime, but this keeps the editor correct for any future caller that
  // toggles it.
  const jsonLinesRef = useRef(jsonLines);
  onChangeRef.current = onChange;
  onValidChangeRef.current = onValidChange;
  onSubmitRef.current = onSubmit;
  onToggleStageRef.current = onToggleStage;
  onCursorStageRef.current = onCursorStage;
  onHoverStageRef.current = onHoverStage;
  jsonLinesRef.current = jsonLines;

  useEffect(() => {
    const fieldsFn = typeof fields === 'function' ? fields : null;

    const keymaps = [indentWithTab];
    if (onSubmitRef.current) {
      keymaps.unshift(
        {
          key: 'Enter',
          run: () => {
            onSubmitRef.current!();
            return true;
          },
        },
        {
          key: 'Shift-Enter',
          run: (view) => {
            view.dispatch(view.state.replaceSelection('\n'));
            return true;
          },
        },
      );
    }

    let validChangeTimer: ReturnType<typeof setTimeout> | null = null;

    const extensions = [
      mode === 'aggregate' ? aggregateSetup : basicSetup,
      keymap.of(keymaps),
      javascript(),
      compact ? compactTheme : baseTheme,
      // The aggregation pipeline editor does NOT soft-wrap. A long stage should
      // scroll horizontally, not fold into five visual lines: the pipeline reads
      // as a numbered list of stages, and wrapping destroys the one-stage-per-line
      // scan that makes it readable. Every other JsonEditor instance keeps
      // wrapping, so nothing else changes.
      //
      // No CSS is needed for the horizontal scroll and none should be added.
      // CodeMirror's base theme already gives `.cm-scroller` `overflow-x: auto`
      // and, absent the `cm-lineWrapping` class, leaves `.cm-content` at
      // `white-space: pre; flex-shrink: 0` — so the scroller gains a real
      // horizontal range on its own. The stage-toggle gutter stays put because
      // CodeMirror's gutters are `position: sticky` by default. (Both verified in
      // @codemirror/view's dist: the baseTheme block and the fixed-gutter branch.)
      ...(mode === 'aggregate' ? [] : [EditorView.lineWrapping]),
      autocompletion({ override: [makeCompletionSource(mode, fieldsFn)] }),
      ...(mode === 'aggregate'
        ? [
            stageToggleGutter((idx) => {
              if (onToggleStageRef.current) onToggleStageRef.current(idx);
            }),
            linkedStageField,
            // Which stage the POINTER is over, so hovering the code lights the
            // same link that hovering the records section does. Deduped to
            // changes, so a pointer moving within one stage reports nothing.
            EditorView.domEventHandlers({
              mousemove(e, view) {
                if (!onHoverStageRef.current) return;
                const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
                const idx =
                  pos == null ? null : entryIndexAtOffset(stageRangesFor(view.state), pos);
                if (idx === lastHoverStageRef.current) return;
                lastHoverStageRef.current = idx;
                onHoverStageRef.current!(idx);
              },
              mouseleave() {
                if (!onHoverStageRef.current || lastHoverStageRef.current == null) return;
                lastHoverStageRef.current = null;
                onHoverStageRef.current!(null);
              },
            }),
          ]
        : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (onChangeRef.current) (onChangeRef.current as any)();
          const text = update.state.doc.toString().trim();
          const errorEl = containerRef.current?.querySelector('.json-editor-error');
          if (!text) {
            if (errorEl) {
              errorEl.textContent = '';
              containerRef.current!.classList.remove('json-editor-invalid');
            }
          } else if (isAcceptable(text, { jsonLines: jsonLinesRef.current })) {
            if (errorEl) {
              errorEl.textContent = '';
              containerRef.current!.classList.remove('json-editor-invalid');
            }
            if (onValidChangeRef.current) {
              clearTimeout(validChangeTimer as any);
              validChangeTimer = setTimeout(onValidChangeRef.current, 500);
            }
          } else {
            // Re-run JSON5.parse purely to recover an error message to show —
            // isAcceptable() already decided this text is invalid.
            try {
              JSON5.parse(text);
            } catch (e: any) {
              if (errorEl) {
                errorEl.textContent = e.message;
                containerRef.current!.classList.add('json-editor-invalid');
              }
            }
          }
        }
        // Aggregate mode: report which stage the caret sits in, as an ENTRY index
        // (deduped to changes) so the Stages view can mark that stage. Same index
        // space and same bare-index shape as onHoverStage above — the caret used
        // to report a second, ACTIVE-stage index as well, which addressed a
        // stage's OUTPUT rather than its section and existed only for the scroll
        // jump that the editor no longer performs (see DataPanel's
        // handleCursorStage).
        if (
          (update.selectionSet || update.focusChanged) &&
          mode === 'aggregate' &&
          onCursorStageRef.current
        ) {
          const ranges = stageRangesFor(update.state);
          const offset = update.state.selection.main.head;
          // Losing focus reports null, so the caret's link clears when the user
          // clicks away — a caret parked in a stage should not keep claiming the
          // panel once the editor is no longer where the user is working.
          const entryIndex = update.view.hasFocus ? entryIndexAtOffset(ranges, offset) : null;
          // Deduped on the ENTRY index, and `undefined` (never reported) is
          // distinct from `null` (reported: outside every stage) — without that
          // distinction the first "left all stages" would be swallowed and the
          // link would never clear.
          if (entryIndex !== lastCursorStageRef.current) {
            lastCursorStageRef.current = entryIndex;
            onCursorStageRef.current!(entryIndex);
          }
        }
      }),
    ];

    if (readOnly) extensions.push(EditorState.readOnly.of(true));
    if (darkQuery.matches) {
      extensions.push(oneDark, darkHighlight);
    } else {
      extensions.push(lightHighlight);
    }

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: containerRef.current! });
    viewRef.current = view;

    const swallowFind = (e: any) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.stopPropagation();
      }
    };
    view.dom.addEventListener('keydown', swallowFind, true);

    // Initial validation
    const text = value.trim();
    if (text && !isAcceptable(text, { jsonLines: jsonLinesRef.current })) {
      const errorEl = containerRef.current?.querySelector('.json-editor-error');
      try {
        JSON5.parse(text);
      } catch (e: any) {
        if (errorEl) {
          errorEl.textContent = e.message;
          containerRef.current!.classList.add('json-editor-invalid');
        }
      }
    }

    return () => {
      clearTimeout(validChangeTimer as any);
      view.dom.removeEventListener('keydown', swallowFind, true);
      view.destroy();
    };
  }, []);

  // Keep read-only editors in sync with their `value` prop. The same instance is
  // reused (no key) when an index / search-index card body changes on a
  // collection switch or a Refresh click, and the mount-only effect above never
  // re-runs — so without this the body would stay stale. Gated on readOnly:
  // editable editors treat `value` as a seed only (edits live in the view, read
  // via editorRef), so syncing there would clobber user input on a re-render.
  useEffect(() => {
    if (!readOnly) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value, readOnly]);

  useEffect(() => {
    if (editorRef) {
      editorRef.current = {
        getValue: () => viewRef.current!.state.doc.toString(),
        // Write back as a MINIMAL change (shared prefix/suffix kept) rather than a
        // whole-document replace, so localized edits — a stage toggle, sort, filter
        // or pagination tweak — don't reset the editor's scroll position to the top
        // (a full replace collapses CodeMirror's scroll anchor to offset 0). See
        // editorDiff.js. A genuinely different document still produces a large change
        // and scrolls toward the top, as before.
        setValue: (v: string) => {
          const view = viewRef.current!;
          const change = computeMinimalChange(view.state.doc.toString(), v);
          if (change) view.dispatch({ changes: change });
        },
        isValid: () => {
          const t = viewRef.current!.state.doc.toString().trim();
          if (!t) return false;
          return isAcceptable(t, { jsonLines: jsonLinesRef.current });
        },
        getParsed: () => JSON5.parse(viewRef.current!.state.doc.toString()),
        getError: () =>
          containerRef.current?.querySelector('.json-editor-error')?.textContent || '',
        // The box that visually CLIPS this editor, so a caller measuring a stage's
        // position can tell whether that stage is actually on screen. Needed
        // because coordsAtPos (see stageScreenRect) happily reports coordinates
        // for a line scrolled out of view — measured 297px above the box — which
        // is how the stage connector came to be drawn over the pipeline header.
        //
        // The INTERSECTION of the container and CodeMirror's scroller, because
        // which of the two clips depends on the layout: in the data panel the
        // outer `.json-editor` is the scroller (console.css:408) and
        // `.cm-scroller`'s rect is the full content height, so the container
        // wins; if a layout ever makes `.cm-scroller` the scroller, its rect is
        // the tighter one and wins instead. null before mount.
        clipRect: () => {
          const box = containerRef.current?.getBoundingClientRect?.();
          if (!box) return null;
          const sc = viewRef.current?.scrollDOM?.getBoundingClientRect?.();
          if (!sc) return box;
          return {
            top: Math.max(box.top, sc.top),
            bottom: Math.min(box.bottom, sc.bottom),
            left: Math.max(box.left, sc.left),
            right: Math.min(box.right, sc.right),
          };
        },
        focus: () => viewRef.current!.focus(),
        refresh: () => viewRef.current!.requestMeasure(),
        // Scroll the given top-level stage's code into view (used once when a
        // Stages-view stage is hovered, so the connector line has an anchor).
        //
        // Does NOTHING while the stage's opening line is already on screen, and
        // otherwise puts that line at the TOP of the visible box. It centred the
        // line unconditionally until 2026-08-14, so hovering a stage you could
        // already read still sent the editor travelling — owner's report. The
        // decision and the target are pure (smoothScroll.revealScrollTop); only
        // the measuring lives here.
        revealStage: (entryIndex) => {
          const view = viewRef.current;
          if (!view) return;
          const r = stageRangesFor(view.state)[entryIndex];
          if (!r) return;
          const lineNo = Math.min(r.lineStart, view.state.doc.lines);
          const pos = view.state.doc.line(lineNo).from;

          // Animated rather than CodeMirror's scrollIntoView effect, which has no
          // behaviour option and always teleports. That means computing the
          // target ourselves — and scrolling the element that ACTUALLY scrolls:
          // `.cm-scroller` has zero range in this layout (console.css:408 makes
          // the outer `.json-editor` the scroller, and the generic
          // `.json-editor .cm-editor { flex: 1 }` has no `min-height: 0`, so
          // `.cm-scroller`'s `height: 100%` never resolves). Writing
          // view.scrollDOM.scrollTop here would silently do nothing.
          const sc = scrollerFor(view, containerRef.current);
          if (!sc) return;
          const scRect = sc.getBoundingClientRect();
          // documentTop is SCREEN-relative and goes negative once scrolled, so
          // this constant converts CodeMirror's document-y into scrollTop space.
          const c = sc.scrollTop + view.documentTop - scRect.top;
          const block = view.lineBlockAt(pos);
          const top = revealScrollTop(
            { top: block.top + c, bottom: block.bottom + c },
            { scrollTop: sc.scrollTop, height: sc.clientHeight },
          );
          if (top == null) return; // already on screen — leave the editor alone
          animateScrollTop(sc, top);
        },
        // Tint the given top-level stage's lines (`.cm-linked-stage`) — the band
        // that accompanies the Stages-view connector, so both ends of the dashed
        // line are marked. `null` clears it. Takes the same ENTRY index as
        // revealStage/stageScreenRect (top-level stages in order, disabled ones
        // included). Safe on a destroyed view: dispatch() returns early there.
        highlightStage: (entryIndex: any) => {
          const view = viewRef.current;
          if (!view) return;
          view.dispatch({ effects: setLinkedStage.of(entryIndex == null ? null : entryIndex) });
        },
        // Viewport rect of the position just AFTER the stage's opening `{`, plus
        // `hEnd` — the x just past the stage operator ($match/$limit/…), i.e. after
        // the first ':' on the line — so the connector's first horizontal can run
        // past the operator. null when the line isn't rendered (scrolled out).
        // Measure only — no scroll.
        stageScreenRect: (entryIndex) => {
          const view = viewRef.current;
          if (!view) return null;
          const text = view.state.doc.toString();
          const r = stageLineRanges(text)[entryIndex];
          if (!r) return null;
          const braceOff = r.start; // the stage's actual '{' — may sit mid-line, e.g. "},{"
          const c = view.coordsAtPos(braceOff + 1); // just after the '{'
          if (!c) return null;
          let hEnd = c.left; // fallback: no extension past the operator
          // The operator's ':' is the first ':' after the '{' — usually on the next
          // line, since stages are pretty-printed. Extend the horizontal past it.
          const colon = operatorColonOffset(text, braceOff, r.end);
          if (colon !== -1) {
            const hc = view.coordsAtPos(colon + 1);
            if (hc) hEnd = hc.left;
          }
          return { top: c.top, bottom: c.bottom, left: c.left, right: c.right, hEnd };
        },
      };
    }
  }, [editorRef]);

  const cls = compact ? 'json-editor json-editor-compact' : 'json-editor';
  const style = compact ? {} : { minHeight };

  return (
    <div class={cls} style={style} ref={containerRef}>
      <div class="json-editor-error"></div>
    </div>
  );
}
