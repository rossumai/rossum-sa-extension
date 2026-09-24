// src/mdh/components/SearchIndexCheck.tsx
//
// The Search Indexes card's test row: one value in, the engine's top hits out, as
// you type — a $search over five hits answers well inside a typing pause.
// Each hit is two quiet lines — what matched, then which record — and one click
// opens either the record or why it scored: the engine's breakdown read as one row
// per matched term, with the raw breakdown always one click below it. Every control a
// hit has lives behind that click, so a list of hits stays two lines each.
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import JsonTree from './JsonTree.jsx';
import CopyButton from '../../ui/CopyButton.jsx';
import { Segmented } from './ImportControls.jsx';
import { firstValidationLine } from '../searchIndexDef.js';
import { recordSummary } from '../recordSummary.js';
import {
  highlightLines,
  summarySkipKeys,
  explainNode,
  explainValue,
  explainTerms,
  type ExplainNode,
  type ExplainTerm,
} from '../searchIndexCheck.js';
import styles from './SearchIndexBuilder.module.css';

// recordSummary packs to a character budget; the line also ellipsises in CSS, so
// this only has to be generous enough for the card's usual width.
const RECORD_LINE_BUDGET = 110;

// The one presentation rule for the RAW breakdown: the top three levels open, the
// rest folded. It counts depth and never reads the engine's text.
const EXPLAIN_OPEN_DEPTH = 3;

// How long typing must pause before the value is searched.
export const CHECK_DEBOUNCE_MS = 300;

const CAVEAT = 'fuzzy over every text field; keyword and multi fields are not searched';

export default function SearchIndexCheck({
  onCheck,
}: {
  onCheck: (value: string) => Promise<any[]>;
}) {
  const [value, setValue] = useState('');
  // The rows AND the value they answer: the value keys the hits, so a new answer
  // remounts them collapsed instead of inheriting open state by position.
  const [result, setResult] = useState<{ value: string; rows: any[] } | null>(null);
  // A failed request is a third outcome, distinct from "no rows" — see below.
  const [error, setError] = useState<string | null>(null);

  // One effect owns both the debounce timer and the request it starts, so its
  // cleanup cancels a pending timer AND discards a late answer to an earlier
  // value — typing on while a request is in flight must not let the older
  // answer land on top of the newer one.
  useEffect(() => {
    if (!value.trim()) {
      setResult(null);
      setError(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await onCheck(value);
        if (stale) return;
        setResult({ value, rows });
        setError(null);
      } catch (err: any) {
        if (stale) return;
        // A failed request (network, auth, a malformed definition) is not a miss —
        // it must never render as "No match", or the row becomes exactly the kind
        // of silent failure it exists to catch.
        setResult(null);
        const detail = firstValidationLine(err?.message);
        setError(detail ? `The check could not run: ${detail}` : 'The check could not run.');
      }
    }, CHECK_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [value]);

  const rows = result?.rows;

  return (
    <div class={styles.checkStrip}>
      <input
        data-testid="check-value"
        class={'input ' + styles.checkInput}
        placeholder="Test with a value from your documents"
        value={value}
        onInput={(e: any) => setValue(e.target.value)}
      />
      {error ? (
        <div class={styles.checkError}>{error}</div>
      ) : (
        rows && (
          <div class={styles.checkResults}>
            <div class={styles.checkMeta} data-testid="check-meta">
              {rows.length === 0
                ? `No match · ${CAVEAT}`
                : `${rows.length} best match${rows.length === 1 ? '' : 'es'} · ${CAVEAT}`}
            </div>
            {rows.length > 0 && (
              <ol class={styles.hitList}>
                {rows.map((row, i) => (
                  <CheckHit key={`${result!.value}:${i}`} row={row} />
                ))}
              </ol>
            )}
          </div>
        )
      )}
    </div>
  );
}

function CheckHit({ row }: { row: any }) {
  const lines = highlightLines(row);
  const record = row && typeof row.record === 'object' ? row.record : null;
  const explain = explainNode(row?.scoreDetails);
  const [open, setOpen] = useState(false);
  // Why it scored is the point of a test, so it opens first; the record only
  // when the engine sent no breakdown.
  const [view, setView] = useState<'record' | 'why'>(explain ? 'why' : 'record');
  const toggle = () => setOpen(!open);

  return (
    <li class={styles.hit} data-testid="check-hit">
      <div
        class={styles.hitRow}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span class={styles.hitChevron}>{open ? '▼' : '▶'}</span>
        <div class={styles.hitMain}>
          <div class={styles.hitMatch}>
            {lines.map((l, i) => (
              <span>
                {i > 0 && <span class={styles.hitSep}>{'·'}</span>}
                <span class={styles.hitPath}>{l.path}</span>
                {l.segments.map((seg) => (seg.hit ? <mark>{seg.text}</mark> : seg.text))}
              </span>
            ))}
          </div>
          {record && (
            <div class={styles.hitRecord} data-testid="check-record">
              {recordSummary(record, RECORD_LINE_BUDGET, { skip: summarySkipKeys(lines) })}
            </div>
          )}
        </div>
        <span class={styles.hitScore}>{Number(row?.score ?? 0).toFixed(2)}</span>
      </div>
      {open && (
        <div class={styles.hitDetail} data-testid="check-detail">
          <div class={styles.hitDetailBar}>
            <Segmented
              quiet
              value={view}
              onChange={setView}
              options={[
                { value: 'why', label: 'Why it scored', disabled: !explain },
                { value: 'record', label: 'Record', disabled: !record },
              ]}
            />
            {view === 'record' && record && (
              <CopyButton className={styles.hitCopy} text={() => JSON.stringify(record, null, 2)} />
            )}
          </div>
          <div class={styles.hitPane}>
            {view === 'record' && record && (
              // JsonTree reads sortState/filterState even read-only; the Stages
              // view passes empty ones the same way.
              <JsonTree data={record} sortState={{}} filterState={{}} readOnly />
            )}
            {view === 'why' && explain && <WhyItScored explain={explain} />}
          </div>
        </div>
      )}
    </li>
  );
}

// The breakdown as a table when it reads cleanly (explainTerms is strict), with
// the raw tree folded underneath; the raw tree alone when it does not. MongoDB
// does not guarantee the format, so the fallback is the design, not an edge.
function WhyItScored({ explain }: { explain: ExplainNode }) {
  const terms = explainTerms(explain);
  const raw = (
    <div class={styles.explainTree} data-testid="check-explain">
      <ExplainTree node={explain} depth={0} />
    </div>
  );
  if (!terms) return raw;
  return (
    <>
      <table class={styles.termTable} data-testid="check-terms">
        <thead>
          <tr>
            <th>Field</th>
            <th>Matched term</th>
            <th>Found in</th>
            <th class={styles.termPoints}>Points</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {terms.map((t) => (
            <tr>
              <td class={styles.termField}>{t.path}</td>
              <td class={styles.termTerm}>{t.term}</td>
              <td class={styles.termFound}>{foundIn(t)}</td>
              <td
                class={styles.termPoints + (pointsHint(t) ? ' ' + styles.termHint : '')}
                title={pointsHint(t) || undefined}
              >
                {explainValue(t.points)}
              </td>
              <td>
                {t.boost !== null && t.boost < 1 && (
                  <span
                    class={styles.termFuzzy}
                    title={`Engine boost ${explainValue(t.boost)} \u2014 below 1, a fuzzy match`}
                  >
                    fuzzy
                  </span>
                )}
              </td>
            </tr>
          ))}
          <tr class={styles.termTotal}>
            <td />
            <td>Score</td>
            <td />
            <td class={styles.termPoints}>{explainValue(explain.value)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <details class={styles.rawToggle} data-testid="check-raw">
        <summary>MongoDB{'\u2019'}s full breakdown</summary>
        {raw}
      </details>
    </>
  );
}

// How rare the term is: a word in thousands of records (GmbH, Inc) earns few
// points, which is the usual answer to "why did this score so low".
function foundIn(t: ExplainTerm): string {
  if (t.docsWithTerm === null || t.docsWithField === null) return '\u2013';
  const n = t.docsWithTerm.toLocaleString('en-US');
  const all = t.docsWithField.toLocaleString('en-US');
  return `${n} of ${all} record${t.docsWithField === 1 ? '' : 's'}`;
}

// Field length and repeat count shape the points but rarely matter, so they
// sit behind the number rather than in columns of their own.
function pointsHint(t: ExplainTerm): string {
  const parts: string[] = [];
  if (t.fieldLength !== null) {
    parts.push(
      `Field length ${explainValue(t.fieldLength)} term${t.fieldLength === 1 ? '' : 's'}` +
        (t.avgFieldLength !== null ? ` (average ${explainValue(t.avgFieldLength)}).` : '.'),
    );
  }
  if (t.freq !== null && t.freq > 1)
    parts.push(`The term occurs ${explainValue(t.freq)} times in it.`);
  return parts.join(' ');
}

// searchScoreDetails as the engine returned it: each node's value, then its
// description word for word. Nested, rounded, foldable — nothing else.
function ExplainTree({ node, depth }: { node: ExplainNode; depth: number }) {
  const line = (
    <>
      <b>{explainValue(node.value)}</b>
      {node.description}
    </>
  );
  if (node.details.length === 0) return <div class={styles.explainLeaf}>{line}</div>;
  return (
    <details open={depth < EXPLAIN_OPEN_DEPTH}>
      <summary>{line}</summary>
      {node.details.map((child) => (
        <ExplainTree node={child} depth={depth + 1} />
      ))}
    </details>
  );
}
