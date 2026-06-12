// src/mdh/pipelineGutter.js
import { gutter, GutterMarker, EditorView, Decoration } from '@codemirror/view';
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { stageLineRanges } from './pipelineComments.js';

// Recomputed stage line ranges, shared by the gutter and the greying decoration.
const stageRangesField = StateField.define({
  create(state) { return stageLineRanges(state.doc.toString()); },
  update(value, tr) { return tr.docChanged ? stageLineRanges(tr.newDoc.toString()) : value; },
});

class ToggleMarker extends GutterMarker {
  constructor(disabled) { super(); this.disabled = disabled; }
  eq(other) { return other.disabled === this.disabled; }
  toDOM() {
    // A real checkbox (checked = stage enabled). It's a visual indicator only —
    // the click is handled by the gutter's line-level mousedown (CSS gives it
    // pointer-events:none), which resolves the clicked line and toggles.
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pipeline-stage-toggle' + (this.disabled ? ' pipeline-stage-toggle-off' : '');
    box.checked = !this.disabled;
    box.tabIndex = -1;
    box.title = this.disabled ? 'Enable stage' : 'Disable stage';
    return box;
  }
}

function rangeForLine(view, lineFrom) {
  const ranges = view.state.field(stageRangesField, false) || [];
  const lineNo = view.state.doc.lineAt(lineFrom).number;
  return ranges.find((r) => r.lineStart === lineNo) || null;
}

const disabledLineDeco = Decoration.line({ class: 'pipeline-stage-disabled-line' });

const disabledDecoField = StateField.define({
  create(state) { return buildDeco(state); },
  update(value, tr) { return tr.docChanged ? buildDeco(tr.state) : value; },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDeco(state) {
  const ranges = stageLineRanges(state.doc.toString());
  const builder = new RangeSetBuilder();
  for (const r of ranges) {
    if (!r.disabled) continue;
    for (let ln = r.lineStart; ln <= r.lineEnd && ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln);
      builder.add(line.from, line.from, disabledLineDeco);
    }
  }
  return builder.finish();
}

// CodeMirror extension array: a clickable per-stage toggle gutter + greying of
// disabled-stage lines. `onToggle(entryIndex)` fires on marker click.
export function stageToggleGutter(onToggle) {
  return [
    stageRangesField,
    disabledDecoField,
    gutter({
      class: 'cm-stage-gutter',
      lineMarker(view, line) {
        const r = rangeForLine(view, line.from);
        return r ? new ToggleMarker(r.disabled) : null;
      },
      lineMarkerChange: (update) => update.docChanged,
      domEventHandlers: {
        mousedown(view, line) {
          const r = rangeForLine(view, line.from);
          if (r) { onToggle(r.entryIndex); return true; }
          return false;
        },
      },
    }),
  ];
}
