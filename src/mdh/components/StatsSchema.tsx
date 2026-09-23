import { h } from 'preact';
import { useState } from 'preact/hooks';
import { buildShapeFilterPipeline } from '../statsView.js';
import { selectedCollection, activePanel, pendingPipelineLoad } from '../store.js';

// The collapsed view keeps the first HEAD_ROWS and the last TAIL_ROWS of the
// common block, eliding only its middle.
const HEAD_ROWS = 6;
const TAIL_ROWS = 3;

type Row = { kind: 'field'; field: string } | { kind: 'more'; count: number } | { kind: 'less' };

// Jump from a shape's column to its matching records: stage a pipeline over
// the shape's own key set and switch to the data view, which consumes
// pendingPipelineLoad. `absentFields` are the fields that differ between
// shapes and this one lacks — the row plan already knows them, so callers
// pass them through rather than recomputing. Mirrors filterToRecords in
// StatsFieldCard.tsx.
function shapeToRecords(fields: string[], absentFields: string[] = []) {
  const collection = selectedCollection.value;
  if (!collection) return;
  pendingPipelineLoad.value = {
    collection,
    pipelineText: buildShapeFilterPipeline(fields, absentFields),
  };
  activePanel.value = 'data';
}

// Alphabetical union of every distinct field across all shapes.
function buildUnion(schemaShapes: any[]): string[] {
  const set = new Set<string>();
  for (const s of schemaShapes) {
    for (const f of s.fields || []) set.add(f);
  }
  return [...set].sort();
}

// A field is varying when it is present in some shapes and absent in others.
function varyingFields(union: string[], schemaShapes: any[]): Set<string> {
  const fieldSets = schemaShapes.map((s) => new Set<string>(s.fields || []));
  const varying = new Set<string>();
  for (const f of union) {
    const presentIn = fieldSets.filter((set) => set.has(f)).length;
    if (presentIn > 0 && presentIn < fieldSets.length) varying.add(f);
  }
  return varying;
}

// One row plan, shared by every column (and the single-shape list), grouped by
// category so there is exactly one collapsible run: the fields common to every
// shape first (alphabetical), collapsed in their middle only, then every
// differing field (alphabetical), always visible. Build once and hand the same
// rows to each column so a gap lands at the same position everywhere.
function buildRowPlan(commonFields: string[], differingFields: string[], expanded: boolean): Row[] {
  const n = commonFields.length;
  const collapsible = n > HEAD_ROWS + TAIL_ROWS + 1;
  const fieldRow = (field: string): Row => ({ kind: 'field', field });
  if (!collapsible) {
    return [...commonFields.map(fieldRow), ...differingFields.map(fieldRow)];
  }
  const head = commonFields.slice(0, HEAD_ROWS);
  const tail = commonFields.slice(n - TAIL_ROWS);
  const middle = commonFields.slice(HEAD_ROWS, n - TAIL_ROWS);
  const rows: Row[] = head.map(fieldRow);
  if (expanded) rows.push(...middle.map(fieldRow));
  else rows.push({ kind: 'more', count: middle.length });
  rows.push(...tail.map(fieldRow));
  rows.push(...differingFields.map(fieldRow));
  // The collapse control terminates the list rather than sitting in the gap's
  // old position: once expanded there is no gap, so mid-list it would divide
  // two runs of common fields and mark nothing.
  if (expanded) rows.push({ kind: 'less' });
  return rows;
}

function ElisionRow({
  row,
  onToggle,
}: {
  row: Extract<Row, { kind: 'more' } | { kind: 'less' }>;
  onToggle: (expand: boolean) => void;
}) {
  if (row.kind === 'less') {
    return (
      <li class="stats-schema-more">
        <button type="button" onClick={() => onToggle(false)}>
          <span class="stats-schema-chev">{'▴'}</span> Show fewer
        </button>
      </li>
    );
  }
  return (
    <li class="stats-schema-more">
      <button type="button" onClick={() => onToggle(true)}>
        <span class="stats-schema-chev">{'▾'}</span> Show {row.count} more
      </button>
    </li>
  );
}

// Side-by-side structures: each shape is a column following the shared row
// plan; a field this shape lacks is ghosted/struck, a field it adds over the
// most common shape is green — so the structures and their differences read
// at once. With a single shape there is nothing to compare, so the header
// drops the "Shape N"/baseline label and the percentage and shows the
// document count instead; the column itself (background, border, width) is
// the same one path either way.
function ShapeColumns({
  schemaShapes,
  rows,
  baselineSet,
  differingFields,
  multi,
  onToggle,
}: {
  schemaShapes: any[];
  rows: Row[];
  baselineSet: Set<string>;
  differingFields: string[];
  multi: boolean;
  onToggle: (expand: boolean) => void;
}) {
  const total = schemaShapes.reduce((sum, x) => sum + x.docCount, 0) || 1;
  return (
    <div class="stats-shape-cols">
      {schemaShapes.map((s, i) => {
        const has = new Set(s.fields || []);
        const absentFields = differingFields.filter((f) => !has.has(f));
        const pct = Math.round((s.docCount / total) * 100);
        return (
          <div class="stats-shape-col">
            <div class="stats-shape-col-h">
              {multi && (
                <span>
                  <b>Shape {i + 1}</b>
                  {i === 0 ? <span class="stats-shape-baseline"> {'·'} most common</span> : ''}
                </span>
              )}
              {multi ? (
                <span class="stats-shape-col-meta">
                  {s.fieldCount} fields {'·'} {s.docCount.toLocaleString()} {'·'}{' '}
                  {pct === 0 && s.docCount > 0 ? '<1' : pct}%
                </span>
              ) : (
                <span class="stats-shape-col-meta">{s.docCount.toLocaleString()} documents</span>
              )}
              <button
                type="button"
                class="stats-shape-records"
                title="Open the Data tab filtered to this shape"
                onClick={() => shapeToRecords(s.fields, absentFields)}
              >
                Show these records
              </button>
            </div>
            <ul>
              {rows.map((row, idx) => {
                if (row.kind !== 'field') {
                  return <ElisionRow key={`more-${idx}`} row={row} onToggle={onToggle} />;
                }
                const f = row.field;
                const present = has.has(f);
                const added = present && !baselineSet.has(f);
                const cls = !present ? 'is-gone' : added ? 'is-add' : '';
                return (
                  <li class={cls} key={f}>
                    <span class="stats-shape-mark">{!present ? '·' : added ? '+' : ''}</span>
                    {f}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export default function StatsSchema({ schemaShapes }: { schemaShapes?: any[] | null }) {
  const multi = !!(schemaShapes && schemaShapes.length > 1);
  const single = schemaShapes && schemaShapes.length === 1 ? schemaShapes[0] : null;
  const [expanded, setExpanded] = useState(false);
  const shapesCount = schemaShapes ? schemaShapes.length : 0;

  let union: string[] = [];
  // The baseline is always shape 0's own fields, single or not: for a single
  // shape that makes it its own baseline, so no field can ever read as "added".
  let baselineSet: Set<string> = new Set<string>(schemaShapes?.[0]?.fields || []);
  let differingFields: string[] = [];
  let rows: Row[] = [];
  if (multi) {
    union = buildUnion(schemaShapes!);
    const varying = varyingFields(union, schemaShapes!);
    const commonFields = union.filter((f) => !varying.has(f));
    differingFields = union.filter((f) => varying.has(f));
    rows = buildRowPlan(commonFields, differingFields, expanded);
  } else if (single) {
    union = single.fields || [];
    rows = buildRowPlan(union, [], expanded);
  }

  return (
    <div>
      <div class="stats-band-label">Schema</div>
      {shapesCount > 0 && (
        <div class="stats-schema-line">
          {multi
            ? `${shapesCount} shapes · ${union.length} fields across all`
            : `Consistent · 1 shape${single.fieldCount != null ? ` · ${single.fieldCount} fields` : ''}`}
        </div>
      )}
      {shapesCount > 0 && rows.length > 0 && (
        <ShapeColumns
          schemaShapes={schemaShapes!}
          rows={rows}
          baselineSet={baselineSet}
          differingFields={differingFields}
          multi={multi}
          onToggle={setExpanded}
        />
      )}
    </div>
  );
}
