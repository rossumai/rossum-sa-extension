import { h } from 'preact';
import { openModal } from './Modal.jsx';

// ---- Pure humanization view-model (DOM-free; rendered by AiRunTraceDetails) --
const APPROACH = { exact: 'direct approach', tolerant: 'format-tolerant', minimal: 'minimal fix', rethink: 'rebuilt' };
const APPROACH_NOTE = {
  exact: 'Translated your request literally, matching stored values exactly.',
  tolerant: 'Allowed for value/format differences (case, codes, text matching).',
  minimal: 'Smallest change to the previous attempt that could fix it.',
  rethink: 'Rewrote the query from scratch with a different strategy.',
};
const TRIGGER_REASON = { empty: 'the previous query returned no rows', error: 'the previous query hit a database error', mismatch: 'the check found' };

function verdictChip(verdict, rowCount) {
  switch (verdict) {
    case 'ok': return { text: `${rowCount} row${rowCount === 1 ? '' : 's'}`, tone: 'ok' };
    case 'empty': return { text: '0 rows · no matches', tone: 'warn' };
    case 'error': return { text: 'database error', tone: 'bad' };
    case 'invalid': return { text: 'not a valid query', tone: 'bad' };
    case 'unrun': return { text: 'ready · not run', tone: 'neutral' };
    case 'failed': return { text: "couldn't write a query", tone: 'bad' };
    case 'duplicate': return { text: 'repeated a previous attempt', tone: 'neutral' };
    default: return { text: String(verdict || 'done'), tone: 'neutral' };
  }
}
function checkChip(status, score) {
  if (status === 'passed') return { text: typeof score === 'number' ? `looks right · ${score}/100` : 'looks right', tone: 'ok' };
  if (status === 'flagged') return { text: "doesn't fully match", tone: 'warn' };
  if (status === 'parse-fail') return { text: "couldn't verify automatically", tone: 'neutral' };
  return { text: 'check failed', tone: 'neutral' };
}

// One render-ready step per LLM call, joined to its round/candidate detail.
export function buildStepViews(trace) {
  if (!trace || !Array.isArray(trace.calls) || trace.calls.length === 0) return [];
  const rounds = Array.isArray(trace.rounds) ? trace.rounds : [];
  return trace.calls.map((call) => {
    const round = rounds[(call.round || 1) - 1];
    const cands = (round && round.candidates) || [];
    if (call.kind === 'verify') {
      const chosen = cands.find((c) => c.picked) || cands.find((c) => c.applied);
      return { kind: 'check', action: 'Checked the result',
        chip: checkChip(call.status, chosen && chosen.score),
        why: round && round.reasoning ? round.reasoning : undefined };
    }
    const cand = cands.find((c) => c.angle === call.angle);
    const verdict = cand ? cand.verdict : call.status; // failed/duplicate have no candidate
    const step = {
      kind: call.kind === 'fix' ? 'refine' : 'write',
      action: call.kind === 'fix' ? 'Refined the query' : 'Wrote a query',
      approach: APPROACH[call.angle] || call.angle,
      note: APPROACH_NOTE[call.angle],
      chip: verdictChip(verdict, cand ? cand.rowCount : 0),
      pipelineText: cand ? cand.pipelineText : undefined,
      sample: cand && Array.isArray(cand.sample) && cand.sample.length ? cand.sample : undefined,
      rowCount: cand ? cand.rowCount : undefined,
    };
    if (call.kind === 'fix' && round) {
      const reason = TRIGGER_REASON[round.trigger];
      if (reason) {
        const issue = round.trigger === 'mismatch' ? (cands.find((c) => c.angle !== call.angle) || {}).issue : undefined;
        step.why = `Retried because ${reason}${issue ? `: ${issue}` : ''}.`;
      }
    }
    return step;
  });
}

function appliedCandidate(trace) {
  for (const r of (trace.rounds || [])) for (const c of (r.candidates || [])) if (c.applied) return c;
  return null;
}
export function outcomeBanner(trace) {
  if (!trace) return null;
  const truncate = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const calls = Array.isArray(trace.calls) ? trace.calls : [];
  const lastVerify = [...calls].reverse().find((c) => c.kind === 'verify');
  const checked = !!lastVerify && lastVerify.status === 'passed';
  const applied = appliedCandidate(trace);
  const tag = trace.corrected ? 'self-corrected' : undefined;
  if (!applied) return { tone: 'bad', icon: '✕', text: 'No usable query produced.', tag };
  const n = applied.rowCount || 0;
  const rows = `${n} row${n === 1 ? '' : 's'}`;
  switch (trace.status) {
    case 'error': return { tone: 'bad', icon: '✕', text: `Query failed${applied.error ? `: ${truncate(applied.error, 80)}` : ''}.`, tag };
    case 'unverified': return { tone: 'neutral', icon: '•', text: 'Query ready — not run.', tag };
    case 'empty': return { tone: 'warn', icon: '⚠', text: 'Applied — 0 rows (no matches).', tag };
    case 'ok': return checked
      ? { tone: 'ok', icon: '✓', text: `Applied a checked query — ${rows}.`, tag }
      : { tone: 'ok', icon: '✓', text: `Applied a query — ${rows} (not checked).`, tag };
    default: return { tone: 'bad', icon: '✕', text: 'No usable query produced.', tag };
  }
}

export function contextBits(hints = {}) {
  const b = [];
  if (hints.collection) b.push(`collection ${hints.collection}`);
  if (hints.fields) b.push(`${hints.fields} field${hints.fields === 1 ? '' : 's'}`);
  if (hints.knownValues && hints.knownValues.length) b.push(`sample values for ${hints.knownValues.join(', ')}`);
  if (hints.searchIndexes && hints.searchIndexes.length) b.push(`search index ${hints.searchIndexes.join(', ')}`);
  if (hints.ranges) b.push(`${hints.ranges} numeric range${hints.ranges === 1 ? '' : 's'}`);
  if (hints.numericStrings && hints.numericStrings.length) b.push(`${hints.numericStrings.length} number-like text field${hints.numericStrings.length === 1 ? '' : 's'}`);
  if (hints.arrayPaths && hints.arrayPaths.length) b.push(`${hints.arrayPaths.length} array field${hints.arrayPaths.length === 1 ? '' : 's'}`);
  return b;
}

export function sampleColumns(rows) {
  const cols = [];
  for (const r of (Array.isArray(rows) ? rows : [])) for (const k of Object.keys(r || {})) if (k !== '_id' && !cols.includes(k)) cols.push(k);
  return cols;
}

const DOT_CLASS = { ok: 'ai-trace-dot-ok', empty: 'ai-trace-dot-warn', error: 'ai-trace-dot-err', unverified: 'ai-trace-dot-muted' };

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function ResultSample({ rows, rowCount }) {
  const cols = sampleColumns(rows);
  const shown = rows.length;
  const cap = typeof rowCount === 'number' && rowCount > shown ? `${shown} of ${rowCount}` : `${shown} row${shown === 1 ? '' : 's'}`;
  return (
    <details class="ai-trace-disc">
      <summary>{`Show results (${cap})`}</summary>
      <div class="ai-trace-results">
        <table class="ai-trace-rows">
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          {rows.map((r, ri) => <tr key={ri}>{cols.map((c) => <td key={c}>{cellText(r[c])}</td>)}</tr>)}
        </table>
      </div>
    </details>
  );
}

// The full run detail — a single humanized, structured step-by-step trace,
// rendered INSIDE the "AI query details" modal. The `.ai-trace-body` wrapper is
// kept (it drives the modal width via `.modal-card:has(.ai-trace-body)`).
export function AiRunTraceDetails({ trace }) {
  if (!trace) return null;
  const banner = outcomeBanner(trace);
  const steps = buildStepViews(trace);
  const ctx = contextBits(trace.hints || {});
  return (
    <div class="modal-body">
      <div class="ai-trace-body">
        {trace.request && (
          <div>
            <div class="ai-trace-ask-label">You asked</div>
            <div class="ai-trace-ask-text">"{trace.request}"</div>
          </div>
        )}
        {banner && (
          <div class={`ai-trace-outcome ai-trace-outcome-${banner.tone}`}>
            <span class="ai-trace-outcome-ic">{banner.icon}</span>
            <span class="ai-trace-outcome-text">{banner.text}</span>
            {banner.tag && <span class="ai-trace-outcome-tag">{banner.tag}</span>}
          </div>
        )}
        {steps.length > 0 && (
          <div class="ai-trace-steps">
            {steps.map((s, i) => (
              <div key={i} class="ai-trace-stepc">
                <div class="ai-trace-rail">
                  <div class={`ai-trace-node ai-trace-node-${s.kind}`}>{i + 1}</div>
                  {i < steps.length - 1 && <div class="ai-trace-connector" />}
                </div>
                <div class="ai-trace-stepbody">
                  <div class="ai-trace-row1">
                    <span class="ai-trace-action">{s.action}</span>
                    {s.approach && <span class="ai-trace-approach">{s.approach}</span>}
                    <span class={`ai-trace-chip ai-trace-chip-${s.chip.tone}`}>{s.chip.text}</span>
                  </div>
                  {s.note && <div class="ai-trace-note">{s.note}</div>}
                  {s.why && <div class="ai-trace-why">{s.why}</div>}
                  {s.pipelineText && (
                    <details class="ai-trace-disc">
                      <summary>Show query</summary>
                      <pre class="ai-trace-query">{s.pipelineText}</pre>
                    </details>
                  )}
                  {s.sample && <ResultSample rows={s.sample} rowCount={s.rowCount} />}
                </div>
              </div>
            ))}
          </div>
        )}
        {ctx.length > 0 && (
          <div class="ai-trace-context"><span class="ai-trace-context-k">What the AI knew:</span> {ctx.join(' · ')}</div>
        )}
        <details class="ai-trace-glossary">
          <summary>What these terms mean</summary>
          <dl class="ai-trace-terms">
            <dt>Approach</dt>
            <dd>direct = literal translation, exact matches · format-tolerant = flexible matching · minimal fix = smallest change to the previous try · rebuilt = rewritten from scratch.</dd>
            <dt>Checked / score</dt>
            <dd>After running, the AI judges how well the rows answer your request (0–100). A mismatch or low score triggers a refine.</dd>
            <dt>What the AI knew</dt>
            <dd>Facts about your collection given to the AI to write a better query — fields, sample values, ranges, search indexes.</dd>
          </dl>
        </details>
      </div>
    </div>
  );
}

// Compact, always-one-line status bar shown under the AI input. At-a-glance
// status (dot + summary + self-corrected tag); clicking opens the detail modal,
// so the bulky candidate/reasoning view never pushes the editor down.
export default function AiRunTrace({ trace }) {
  if (!trace) return null;
  const dot = DOT_CLASS[trace.status] || 'ai-trace-dot-muted';
  return (
    <div class="ai-trace">
      <button
        class="ai-trace-bar"
        title="View AI query details"
        onClick={() => openModal('AI query details', () => <AiRunTraceDetails trace={trace} />)}
      >
        <span class={`ai-trace-dot ${dot}`} />
        <span class="ai-trace-summary">{trace.summary}</span>
        {trace.corrected && <span class="ai-trace-tag">self-corrected</span>}
        <span class="ai-trace-chevron">{'›'}</span>
      </button>
    </div>
  );
}
