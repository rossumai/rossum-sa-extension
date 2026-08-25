import { h } from 'preact';
import { useState } from 'preact/hooks';

// Show the field-by-field structure inline only up to this many distinct fields
// (across all shapes); larger schemas collapse behind a toggle so a 50-field
// structure doesn't dominate the panel by default.
const INLINE_FIELD_LIMIT = 20;

// Union of fields across shapes, baseline (most common) first then any extra
// fields other shapes introduce. `baselineSet` marks which union fields the
// most-common shape has, so other shapes can flag their additions.
function buildUnion(schemaShapes: any[]) {
  const baseline: string[] = schemaShapes[0]?.sampleFields || [];
  const seen = new Set<string>(baseline);
  const extras: string[] = [];
  for (let i = 1; i < schemaShapes.length; i++) {
    for (const f of schemaShapes[i].sampleFields || []) {
      if (!seen.has(f)) {
        seen.add(f);
        extras.push(f);
      }
    }
  }
  extras.sort();
  return { union: [...baseline, ...extras], baselineSet: new Set(baseline) };
}

// Side-by-side structures: each shape is a column listing the union of fields;
// a field this shape lacks is ghosted/struck, a field it adds over the most
// common shape is green — so the structures and their differences read at once.
function ShapeColumns({
  schemaShapes,
  union,
  baselineSet,
}: {
  schemaShapes: any[];
  union: string[];
  baselineSet: Set<string>;
}) {
  const total = schemaShapes.reduce((sum, x) => sum + x.docCount, 0) || 1;
  return (
    <div class="stats-shape-cols">
      {schemaShapes.map((s, i) => {
        const has = new Set(s.sampleFields || []);
        const pct = Math.round((s.docCount / total) * 100);
        return (
          <div class="stats-shape-col">
            <div class="stats-shape-col-h">
              <span>
                <b>Shape {i + 1}</b>
                {i === 0 ? <span class="stats-shape-baseline"> {'·'} most common</span> : ''}
              </span>
              <span class="stats-shape-col-meta">
                {s.fieldCount} fields {'·'} {s.docCount.toLocaleString()} {'·'}{' '}
                {pct === 0 && s.docCount > 0 ? '<1' : pct}%
              </span>
            </div>
            <ul>
              {union.map((f) => {
                const present = has.has(f);
                const added = present && !baselineSet.has(f);
                const cls = !present ? 'is-gone' : added ? 'is-add' : '';
                return (
                  <li class={cls}>
                    <span class="mk">{!present ? '·' : added ? '+' : ''}</span>
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
  const multi = schemaShapes && schemaShapes.length > 1;
  const fieldCount = schemaShapes && schemaShapes[0] ? schemaShapes[0].fieldCount : null;
  const u = multi ? buildUnion(schemaShapes) : null;
  const unionSize = u ? u.union.length : 0;
  const long = unionSize > INLINE_FIELD_LIMIT;
  const [expanded, setExpanded] = useState(false);
  const showCols = multi && (!long || expanded);
  return (
    <div>
      <div class="stats-band-label">Schema</div>
      {!multi && (
        <div class="stats-schema-line">
          Consistent {'·'} 1 shape{fieldCount != null ? ` · ${fieldCount} fields` : ''}
        </div>
      )}
      {multi && long && (
        <button class="stats-shape-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide structure' : `Show field-by-field structure (${unionSize} fields)`}
          <span class="stats-shape-chevron">{expanded ? '▾' : '▸'}</span>
        </button>
      )}
      {showCols && (
        <ShapeColumns schemaShapes={schemaShapes!} union={u!.union} baselineSet={u!.baselineSet} />
      )}
    </div>
  );
}
