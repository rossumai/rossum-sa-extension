// src/mdh/components/JsonEditor.jsx
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { indentWithTab, history, defaultKeymap, historyKeymap } from '@codemirror/commands';
// We use the JavaScript grammar (a strict superset of JSON5) so that line and
// block comments inside prefilled templates are tokenized as comments instead
// of falling through as untagged text. JSON5.parse below still owns validation.
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle, indentOnInput, bracketMatching, foldKeymap } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import JSON5 from 'json5';
import { stageToggleGutter } from '../pipelineGutter.js';
import { stageLineRanges, activeStageIndexAtOffset } from '../pipelineComments.js';
import { operatorColonOffset } from '../stageLink.js';
import { computeMinimalChange } from '../editorDiff.js';
import { makeCompletionSource } from '../pipelineCompletions.js';
// Re-exported for PipelineEditor.jsx / DataPanel.jsx, which import it from here.
export { extractFieldNames } from '../pipelineCompletions.js';

// Pure: is `text` acceptable for this editor instance? JSON5 everywhere; with
// `jsonLines` also accept NDJSON (every non-empty line is strict JSON on its
// own) — the clipboard import stage's Next path (getFormat('json').parse)
// accepts JSON-lines via an NDJSON fallback, so the editor's validation must
// not contradict it. Every other consumer (default jsonLines=false, incl. the
// pipeline editor) keeps strict JSON5-only behavior.
export function isAcceptable(text, { jsonLines = false } = {}) {
  try { JSON5.parse(text); return true; } catch { /* fall through */ }
  if (!jsonLines) return false;
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return false;
  try { for (const l of lines) JSON.parse(l); return true; } catch { return false; }
}

const darkQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false };

const lightHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.string, color: '#22883e' },
  { tag: tags.number, color: '#b45309' },
  { tag: tags.bool, color: '#4270db' },
  { tag: tags.null, color: '#7a7a8c' },
  { tag: tags.propertyName, color: '#1a1a24' },
  { tag: [tags.lineComment, tags.blockComment], color: '#7a7a8c', fontStyle: 'italic' },
]));

const darkHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.string, color: '#34d058' },
  { tag: tags.number, color: '#f59e0b' },
  { tag: tags.bool, color: '#5b8af0' },
  { tag: tags.null, color: '#8888a0' },
  { tag: tags.propertyName, color: '#dddde8' },
  { tag: [tags.lineComment, tags.blockComment], color: '#8888a0', fontStyle: 'italic' },
]));

const baseTheme = EditorView.theme({
  '&': { fontSize: '12px', flex: '1' },
  '.cm-scroller': { fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace", overflow: 'auto' },
  '.cm-gutters': { border: 'none' },
});

const compactTheme = EditorView.theme({
  '&': { fontSize: '12px', flex: '1' },
  '.cm-scroller': { fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace", overflow: 'auto' },
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


export default function JsonEditor({ value = '', onChange, onValidChange, onToggleStage, onCursorStage, mode = 'default', fields, compact = false, readOnly = false, onSubmit, editorRef, minHeight = '200px', jsonLines = false }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onValidChangeRef = useRef(onValidChange);
  const onSubmitRef = useRef(onSubmit);
  const onToggleStageRef = useRef(onToggleStage);
  const onCursorStageRef = useRef(onCursorStage);
  const lastCursorStageRef = useRef(null);
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
  jsonLinesRef.current = jsonLines;

  useEffect(() => {
    const fieldsFn = typeof fields === 'function' ? fields : null;

    const keymaps = [indentWithTab];
    if (onSubmitRef.current) {
      keymaps.unshift(
        { key: 'Enter', run: () => { onSubmitRef.current(); return true; } },
        { key: 'Shift-Enter', run: (view) => { view.dispatch(view.state.replaceSelection('\n')); return true; } },
      );
    }

    let validChangeTimer = null;

    const extensions = [
      mode === 'aggregate' ? aggregateSetup : basicSetup,
      keymap.of(keymaps),
      javascript(),
      compact ? compactTheme : baseTheme,
      EditorView.lineWrapping,
      autocompletion({ override: [makeCompletionSource(mode, fieldsFn)] }),
      ...(mode === 'aggregate'
        ? [stageToggleGutter((idx) => { if (onToggleStageRef.current) onToggleStageRef.current(idx); })]
        : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (onChangeRef.current) onChangeRef.current();
          const text = update.state.doc.toString().trim();
          const errorEl = containerRef.current?.querySelector('.json-editor-error');
          if (!text) {
            if (errorEl) { errorEl.textContent = ''; containerRef.current.classList.remove('json-editor-invalid'); }
          } else if (isAcceptable(text, { jsonLines: jsonLinesRef.current })) {
            if (errorEl) { errorEl.textContent = ''; containerRef.current.classList.remove('json-editor-invalid'); }
            if (onValidChangeRef.current) {
              clearTimeout(validChangeTimer);
              validChangeTimer = setTimeout(onValidChangeRef.current, 500);
            }
          } else {
            // Re-run JSON5.parse purely to recover an error message to show —
            // isAcceptable() already decided this text is invalid.
            try { JSON5.parse(text); }
            catch (e) { if (errorEl) { errorEl.textContent = e.message; containerRef.current.classList.add('json-editor-invalid'); } }
          }
        }
        // Aggregate mode: report which stage the cursor is in (active-stage index,
        // deduped to changes) so the Stages view can follow the cursor.
        if (update.selectionSet && mode === 'aggregate' && onCursorStageRef.current) {
          const found = activeStageIndexAtOffset(
            stageLineRanges(update.state.doc.toString()),
            update.state.selection.main.head,
          );
          if (found != null && found !== lastCursorStageRef.current) {
            lastCursorStageRef.current = found;
            onCursorStageRef.current(found);
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
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    const swallowFind = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.stopPropagation();
      }
    };
    view.dom.addEventListener('keydown', swallowFind, true);

    // Initial validation
    const text = value.trim();
    if (text && !isAcceptable(text, { jsonLines: jsonLinesRef.current })) {
      const errorEl = containerRef.current?.querySelector('.json-editor-error');
      try { JSON5.parse(text); }
      catch (e) { if (errorEl) { errorEl.textContent = e.message; containerRef.current.classList.add('json-editor-invalid'); } }
    }

    return () => {
      clearTimeout(validChangeTimer);
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
        getValue: () => viewRef.current.state.doc.toString(),
        // Write back as a MINIMAL change (shared prefix/suffix kept) rather than a
        // whole-document replace, so localized edits — a stage toggle, sort, filter
        // or pagination tweak — don't reset the editor's scroll position to the top
        // (a full replace collapses CodeMirror's scroll anchor to offset 0). See
        // editorDiff.js. A genuinely different document still produces a large change
        // and scrolls toward the top, as before.
        setValue: (v) => {
          const view = viewRef.current;
          const change = computeMinimalChange(view.state.doc.toString(), v);
          if (change) view.dispatch({ changes: change });
        },
        isValid: () => { const t = viewRef.current.state.doc.toString().trim(); if (!t) return false; return isAcceptable(t, { jsonLines: jsonLinesRef.current }); },
        getParsed: () => JSON5.parse(viewRef.current.state.doc.toString()),
        getError: () => containerRef.current?.querySelector('.json-editor-error')?.textContent || '',
        focus: () => viewRef.current.focus(),
        refresh: () => viewRef.current.requestMeasure(),
        // Scroll the given top-level stage's code into view (used once when a
        // Stages-view stage is hovered, so the connector line has an anchor).
        revealStage: (entryIndex) => {
          const view = viewRef.current;
          if (!view) return;
          const r = stageLineRanges(view.state.doc.toString())[entryIndex];
          if (!r) return;
          const lineNo = Math.min(r.lineStart, view.state.doc.lines);
          view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(lineNo).from, { y: 'center' }) });
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
