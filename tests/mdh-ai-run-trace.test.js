// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import AiRunTrace, { AiRunTraceDetails, buildStepViews, outcomeBanner, contextBits, sampleColumns } from '../src/mdh/components/AiRunTrace.jsx';
import { modalContent } from '../src/mdh/store.js';

function mount(comp, props) {
  const root = document.createElement('div');
  render(h(comp, props), root);
  return root;
}

const trace = {
  request: 'products under 50 in Tools', status: 'ok', summary: 'AI-checked · 12 rows', corrected: false,
  calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'passed' }],
  rounds: [{ kind: 'initial', reasoning: 'all rows match', candidates: [
    { angle: 'exact', pipelineText: '[{"$limit":12}]', verdict: 'ok', rowCount: 12, sample: [{ sku: 'A1', price: 9 }], score: 95, picked: true, applied: true },
  ] }],
  hints: { collection: 'products', fields: 9, knownValues: ['category'], ranges: 1 },
};
const correctedTrace = {
  request: 'vendors in California', status: 'ok', summary: 'AI-checked · 8 rows', corrected: true,
  calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'empty' },
    { kind: 'fix', round: 2, angle: 'minimal', status: 'ok' }, { kind: 'verify', round: 2, status: 'passed' }],
  rounds: [
    { kind: 'initial', candidates: [{ angle: 'exact', pipelineText: '[{"$match":{"state":"California"}}]', verdict: 'empty', rowCount: 0, picked: true, applied: false }] },
    { kind: 'correction', trigger: 'empty', reasoning: 'now matches', candidates: [
      { angle: 'exact', pipelineText: '[{"$match":{"state":"California"}}]', verdict: 'empty', rowCount: 0, picked: false, applied: false },
      { angle: 'minimal', pipelineText: '[{"$match":{"state":"CA"}}]', verdict: 'ok', rowCount: 8, sample: [{ name: 'Northwind', state: 'CA' }], score: 90, picked: true, applied: true },
    ] },
  ],
  hints: { collection: 'vendors', fields: 12 },
};

describe('AiRunTrace bar', () => {
  beforeEach(() => { modalContent.value = null; });
  it('renders nothing without a trace', () => { expect(mount(AiRunTrace, { trace: null }).textContent).toBe(''); });
  it('shows summary + status dot, no detail inline', () => {
    const root = mount(AiRunTrace, { trace });
    expect(root.textContent).toContain('AI-checked · 12 rows');
    expect(root.querySelector('.ai-trace-dot')).toBeTruthy();
    expect(root.querySelector('.ai-trace-body')).toBeNull();
  });
  it('shows the self-corrected tag when corrected', () => {
    expect(mount(AiRunTrace, { trace: correctedTrace }).querySelector('.ai-trace-tag')).toBeTruthy();
  });
});

describe('AiRunTraceDetails (humanized step view)', () => {
  beforeEach(() => { modalContent.value = null; });
  it('renders nothing without a trace', () => { expect(mount(AiRunTraceDetails, { trace: null }).textContent).toBe(''); });
  it('shows request, outcome, numbered steps, chips, glossary', () => {
    const root = mount(AiRunTraceDetails, { trace });
    expect(root.querySelector('.ai-trace-body')).toBeTruthy();
    expect(root.textContent).toContain('You asked');
    expect(root.textContent).toContain('products under 50 in Tools');
    expect(root.querySelector('.ai-trace-outcome-ok')).toBeTruthy();
    expect(root.textContent).toContain('Applied a checked query — 12 rows');
    expect(root.querySelectorAll('.ai-trace-stepc')).toHaveLength(2);
    expect(root.textContent).toContain('Wrote a query');
    expect(root.textContent).toContain('direct approach');
    expect(root.textContent).toContain('looks right · 95/100');
    expect(root.querySelector('.ai-trace-node-check')).toBeTruthy();
    expect(root.textContent).toContain('What the AI knew');
    expect(root.textContent).toContain('collection products');
    expect(root.querySelector('.ai-trace-glossary')).toBeTruthy();
    expect(root.textContent).not.toContain('verified ·'); // no leftover jargon marker
  });
  it('shows query + result-sample collapsibles whose content reveals on open', () => {
    const root = mount(AiRunTraceDetails, { trace });
    const discs = root.querySelectorAll('details.ai-trace-disc');
    expect(discs.length).toBe(2); // Show query + Show results
    expect(root.textContent).toContain('Show query');
    expect(root.textContent).toContain('Show results');
    expect(root.querySelector('.ai-trace-query').textContent).toContain('$limit');
    expect(root.querySelector('.ai-trace-rows')).toBeTruthy(); // sample table present
    expect(root.textContent).toContain('sku');
  });
  it('corrected run → 3 steps incl. a refine with a why, and self-corrected tag', () => {
    const root = mount(AiRunTraceDetails, { trace: correctedTrace });
    expect(root.querySelectorAll('.ai-trace-stepc')).toHaveLength(3);
    expect(root.textContent).toContain('Refined the query');
    expect(root.textContent).toContain('minimal fix');
    expect(root.textContent).toContain('Retried because the previous query returned no rows');
    expect(root.querySelector('.ai-trace-node-refine')).toBeTruthy();
    expect(root.querySelector('.ai-trace-outcome-tag')).toBeTruthy();
  });
  it('opens from the bar with the new content', () => {
    const root = mount(AiRunTrace, { trace });
    root.querySelector('.ai-trace-bar').click();
    expect(modalContent.value.title).toBe('AI query details');
    const body = document.createElement('div');
    render(modalContent.value.render(), body);
    expect(body.querySelector('.ai-trace-body')).toBeTruthy();
    expect(body.textContent).toContain('Wrote a query');
  });
});

describe('buildStepViews (humanized step model)', () => {
  const happy = {
    request: 'q', status: 'ok', corrected: false,
    calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'passed' }],
    rounds: [{ kind: 'initial', reasoning: 'rows match the request',
      candidates: [{ angle: 'exact', pipelineText: '[{"$limit":12}]', verdict: 'ok', rowCount: 12, sample: [{ a: 1 }], score: 95, picked: true, applied: true }] }],
  };
  it('happy path → [write, check] with humanized labels, query + sample on write', () => {
    const s = buildStepViews(happy);
    expect(s.map((x) => x.kind)).toEqual(['write', 'check']);
    expect(s[0].action).toBe('Wrote a query');
    expect(s[0].approach).toBe('direct approach');
    expect(s[0].chip).toEqual({ text: '12 rows', tone: 'ok' });
    expect(s[0].pipelineText).toBe('[{"$limit":12}]');
    expect(s[0].sample).toEqual([{ a: 1 }]);
    expect(s[1].action).toBe('Checked the result');
    expect(s[1].chip).toEqual({ text: 'looks right · 95/100', tone: 'ok' });
    expect(s[1].why).toBe('rows match the request');
  });
  it('self-corrected (empty → minimal fix → passed) → [write, refine, check] with why', () => {
    const t = {
      request: 'q', status: 'ok', corrected: true,
      calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'empty' },
        { kind: 'fix', round: 2, angle: 'minimal', status: 'ok' }, { kind: 'verify', round: 2, status: 'passed' }],
      rounds: [
        { kind: 'initial', candidates: [{ angle: 'exact', pipelineText: '[]', verdict: 'empty', rowCount: 0, picked: true, applied: false }] },
        { kind: 'correction', trigger: 'empty', reasoning: 'now matches',
          candidates: [{ angle: 'exact', pipelineText: '[]', verdict: 'empty', rowCount: 0, picked: false, applied: false },
            { angle: 'minimal', pipelineText: '[{"$match":{"x":1}}]', verdict: 'ok', rowCount: 8, sample: [{ x: 1 }], score: 90, picked: true, applied: true }] },
      ],
    };
    const s = buildStepViews(t);
    expect(s.map((x) => x.kind)).toEqual(['write', 'refine', 'check']);
    expect(s[1].action).toBe('Refined the query');
    expect(s[1].approach).toBe('minimal fix');
    expect(s[1].why).toBe('Retried because the previous query returned no rows.');
    expect(s[1].chip).toEqual({ text: '8 rows', tone: 'ok' });
  });
  it('mismatch refine → why includes the incumbent issue', () => {
    const t = { request: 'q', status: 'ok', corrected: true,
      calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'flagged' },
        { kind: 'fix', round: 2, angle: 'minimal', status: 'ok' }, { kind: 'verify', round: 2, status: 'passed' }],
      rounds: [
        { kind: 'initial', candidates: [{ angle: 'exact', verdict: 'ok', rowCount: 5, issue: 'wrong field', picked: true, applied: false }] },
        { kind: 'correction', trigger: 'mismatch',
          candidates: [{ angle: 'exact', verdict: 'ok', rowCount: 5, issue: 'wrong field', picked: false, applied: false },
            { angle: 'minimal', verdict: 'ok', rowCount: 7, picked: true, applied: true }] },
      ] };
    expect(buildStepViews(t)[2].why).toBe('Retried because the check found: wrong field.');
  });
  it('a failed fix call (no candidate) → chip but no query/sample', () => {
    const t = { request: 'q', status: 'ok', corrected: false,
      calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'flagged' },
        { kind: 'fix', round: 2, angle: 'minimal', status: 'failed' }],
      rounds: [{ kind: 'initial', candidates: [{ angle: 'exact', verdict: 'ok', rowCount: 5, picked: true, applied: true }] }] };
    const last = buildStepViews(t).at(-1);
    expect(last.kind).toBe('refine');
    expect(last.chip).toEqual({ text: "couldn't write a query", tone: 'bad' });
    expect(last.pipelineText).toBeUndefined();
    expect(last.sample).toBeUndefined();
  });
  it('no calls → []', () => {
    expect(buildStepViews({ request: 'q', status: 'ok', rounds: [] })).toEqual([]);
  });
});

describe('outcomeBanner', () => {
  const mk = (status, applied, calls, corrected) => ({ status, corrected,
    calls: calls || [], rounds: [{ candidates: [applied] }] });
  it('ok + checked', () => {
    const b = outcomeBanner(mk('ok', { applied: true, rowCount: 12, verdict: 'ok' }, [{ kind: 'verify', status: 'passed' }]));
    expect(b).toMatchObject({ tone: 'ok', icon: '✓', text: 'Applied a checked query — 12 rows.' });
  });
  it('ok + not checked → "(not checked)"', () => {
    const b = outcomeBanner(mk('ok', { applied: true, rowCount: 1, verdict: 'ok' }, []));
    expect(b.text).toBe('Applied a query — 1 row (not checked).');
  });
  it('empty / error / unverified / no-chosen + self-corrected tag', () => {
    expect(outcomeBanner(mk('empty', { applied: true, rowCount: 0, verdict: 'empty' }, [{ kind: 'verify', status: 'flagged' }])).tone).toBe('warn');
    expect(outcomeBanner(mk('error', { applied: true, verdict: 'error', error: 'bad stage' }, [])).text).toBe('Query failed: bad stage.');
    expect(outcomeBanner(mk('unverified', { applied: true, verdict: 'unrun' }, [])).text).toBe('Query ready — not run.');
    expect(outcomeBanner({ status: 'ok', rounds: [], calls: [] }).text).toBe('No usable query produced.');
    expect(outcomeBanner(mk('ok', { applied: true, rowCount: 3, verdict: 'ok' }, [{ kind: 'verify', status: 'passed' }], true)).tag).toBe('self-corrected');
  });
});

describe('contextBits', () => {
  it('humanizes hints', () => {
    expect(contextBits({ collection: 'vendors', fields: 12, knownValues: ['state', 'country'], searchIndexes: ['default'], ranges: 1 }))
      .toEqual(['collection vendors', '12 fields', 'sample values for state, country', 'search index default', '1 numeric range']);
  });
  it('empty hints → []', () => { expect(contextBits({})).toEqual([]); });
});

describe('sampleColumns', () => {
  it('first-seen order, excludes _id', () => {
    expect(sampleColumns([{ _id: 1, name: 'a', qty: 2 }, { name: 'b', extra: 9 }])).toEqual(['name', 'qty', 'extra']);
  });
});
