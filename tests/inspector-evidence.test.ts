import { describe, it, expect } from 'vitest';
import { schemaIdForDatapoint, fieldThresholds, computeVerdict, buildEvidence } from '../src/inspector/evidence.js';

const CONTENT = [{ category: 'section', children: [
  { category: 'datapoint', id: 101, schema_id: 'po_number', content: { value: '', rir_confidence: 0.31 } },
  { category: 'multivalue', children: [{ category: 'datapoint', id: 102, schema_id: 'item_total', content: { value: '5' } }] },
]}];

describe('schemaIdForDatapoint', () => {
  it('resolves nested datapoint ids (string or number)', () => {
    expect(schemaIdForDatapoint(CONTENT, '101')).toBe('po_number');
    expect(schemaIdForDatapoint(CONTENT, 102)).toBe('item_total');
    expect(schemaIdForDatapoint(CONTENT, '999')).toBe(null);
  });
});

describe('fieldThresholds', () => {
  it('collects per-field score_threshold with queue default fallback', () => {
    const schema = { content: [{ category: 'section', children: [
      { category: 'datapoint', id: 'po_number', score_threshold: 0.9 },
      { category: 'datapoint', id: 'total' },
    ]}] };
    const t = fieldThresholds(schema, { default_score_threshold: 0.8 });
    expect(t.bySchemaId.po_number).toBe(0.9);
    expect(t.bySchemaId.total).toBeUndefined();
    expect(t.defaultThreshold).toBe(0.8);
  });
  it('walks a real schema tree where multivalue.children is an OBJECT (tuple template), not an array', () => {
    // Live-verified 2026-07-04 on a real invoice schema: sections and tuples carry
    // array children, but a multivalue's children is a single tuple OBJECT. The
    // walk must descend into it (line-item thresholds live inside) and not throw.
    const schema = { content: [{ category: 'section', children: [
      { category: 'datapoint', id: 'total', score_threshold: 0.7 },
      { category: 'multivalue', id: 'line_items', children:
        { category: 'tuple', id: 'line_item', children: [
          { category: 'datapoint', id: 'item_amount', score_threshold: 0.95 },
          { category: 'datapoint', id: 'item_desc' },
        ] },
      },
    ]}] };
    const t = fieldThresholds(schema, { default_score_threshold: 0.8 });
    expect(t.bySchemaId.total).toBe(0.7);
    expect(t.bySchemaId.item_amount).toBe(0.95);
    expect(t.bySchemaId.item_desc).toBeUndefined();
  });
});

describe('computeVerdict', () => {
  const queue = { default_score_threshold: 0.8, automation_level: 'always' };
  it('automated annotation → success', () => {
    const v = computeVerdict({ annotation: { status: 'exported', automated: true }, blocker: null, content: null, queue, schema: null });
    expect(v.state).toBe('automated');
    expect(v.severity).toBe('success');
  });
  it('automation off → automation-off with queue fact', () => {
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker: null, content: null,
      queue: { automation_level: 'never' }, schema: null });
    expect(v.state).toBe('automation-off');
    expect(v.headline).toContain('automation');
  });
  it('blockers → blocked, low_score reason names field + numbers', () => {
    const blocker = { content: [
      { type: 'error_message', level: 'annotation' },
      { type: 'low_score', schema_id: 'po_number', samples: [{ datapoint_id: 101, details: { score: 0.31, threshold: 0.8 } }] },
    ] };
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker, content: { content: [] }, queue, schema: null });
    expect(v.state).toBe('blocked');
    expect(v.severity).toBe('danger');
    const low = v.reasons.find((r) => r.evidenceId === 'blocker:1');
    expect(low.fact).toContain('po_number');
    expect(low.fact).toContain('0.31');
  });
  it('rejected / failed_export outrank in-review', () => {
    expect(computeVerdict({ annotation: { status: 'rejected' }, blocker: null, content: null, queue, schema: null }).state).toBe('rejected');
    expect(computeVerdict({ annotation: { status: 'failed_export' }, blocker: null, content: null, queue, schema: null }).state).toBe('export-failed');
  });
  it('no blockers, not automated → honest in-review', () => {
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker: { content: [] }, content: null, queue, schema: null });
    expect(v.state).toBe('in-review');
    expect(v.headline).not.toMatch(/because/i);   // no invented cause
  });
  it('rejected status takes precedence over blockers', () => {
    const blocker = { content: [{ type: 'error_message', level: 'annotation' }] };
    const v = computeVerdict({ annotation: { status: 'rejected', automated: true }, blocker, content: null, queue, schema: null });
    expect(v.state).toBe('rejected');
  });
  it('failed_export status takes precedence over blockers', () => {
    const blocker = { content: [{ type: 'error_message', level: 'annotation' }] };
    const v = computeVerdict({ annotation: { status: 'failed_export', automated: true }, blocker, content: null, queue, schema: null });
    expect(v.state).toBe('export-failed');
  });
  it('not-recorded: null blocker, not automated → honest state without invented cause', () => {
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker: null, content: null, queue, schema: null });
    expect(v.state).toBe('not-recorded');
    expect(v.headline).not.toMatch(/because/i);
  });
  it('missing queue/schema robustness with low_score blocker', () => {
    const blocker = { content: [{ type: 'low_score', schema_id: 'total', samples: [{ details: { score: 0.5 } }] }] };
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker, content: null, queue: undefined, schema: null });
    expect(v.state).toBe('blocked');
    const low = v.reasons.find((r) => r.evidenceId === 'blocker:0');
    expect(low.fact).toContain('0.5');
    expect(low.fact).toContain('?');
    expect(low.fact).not.toMatch(/undefined|NaN/);
  });
  it('automation off with non-empty blockers → automation-off takes precedence', () => {
    const blocker = { content: [{ type: 'low_score', schema_id: 'total', samples: [{ details: { score: 0.5 } }] }] };
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker, content: null,
      queue: { automation_level: 'never', default_score_threshold: 0.8 }, schema: null });
    expect(v.state).toBe('automation-off');
  });
});

describe('buildEvidence — core items', () => {
  function baseInput(over = {}) {
    return {
      annotation: { id: 1, status: 'to_review', automated: false, messages: [], labels: [] },
      blocker: { content: [] }, content: { content: [] },
      queue: { default_score_threshold: 0.8 }, schema: null, document: null,
      parentDocument: null, relations: [], email: null,
      enrichment: { workflow: [], notes: [], hookLogs: [], ruleLogs: [] },
      resolved: { usersById: {}, hooksById: {}, labelsById: undefined, labelRules: [] },
      workflowRuns: [], workflowSteps: [], attributions: {},
      ...over,
    };
  }

  it('message items carry attribution culprit and resolved field name', () => {
    const input = baseInput({
      annotation: { id: 1, status: 'to_review', messages: [
        { type: 'error', content: 'Bad value', id: 101, detail: { rule_id: 7, rule_name: 'PO required' } },
      ], labels: [] },
      content: { content: [{ category: 'section', children: [{ category: 'datapoint', id: 101, schema_id: 'po_number', content: { value: '' } }] }] },
    });
    const { items } = buildEvidence(input);
    const m = items.find((i) => i.id === 'message:0');
    expect(m.section).toBe('blockers');
    expect(m.fact).toContain('po_number');
    expect(m.culprit.name).toBe('PO required');
    expect(m.reliability).toBe('verified');
  });
  it('merges a residual AI attribution into the matching item', () => {
    const input = baseInput({
      annotation: { id: 1, status: 'to_review', messages: [{ type: 'error', content: 'X', detail: {} }], labels: [] },
      attributions: { 'message:0': { status: 'done', source: 'ai', verdict: { culprit: { kind: 'hook', id: 9, name: 'Exporter' }, confidence: 'medium', explanation: 'e' } } },
    });
    const m = buildEvidence(input).items.find((i) => i.id === 'message:0');
    expect(m.culprit.name).toBe('Exporter');
    expect(m.reliability).toBe('best-effort');
  });
  it('field items cover every datapoint (human edits included) with confidence + threshold', () => {
    const input = baseInput({
      content: { content: [{ category: 'section', children: [
        { category: 'datapoint', id: 1, schema_id: 'total', content: { value: '10', rir_confidence: 0.97 }, validation_sources: ['score'] },
        { category: 'datapoint', id: 2, schema_id: 'note', content: { value: 'x' }, validation_sources: ['human'] },
      ] }] },
    });
    const { items } = buildEvidence(input);
    expect(items.find((i) => i.id === 'field:total')).toBeTruthy();
    expect(items.find((i) => i.id === 'field:total').data.threshold).toBe(0.8);
    expect(items.find((i) => i.id === 'field:note')).toBeTruthy();
  });
  it('aggregates a repeated line-item schema_id into ONE item (no colliding ids / prompt bloat)', () => {
    // A line-item COLUMN (item_amount) repeats across rows. Old behavior emitted one item
    // per cell, all sharing id "field:item_amount" (citation/anchor collision + prompt bloat).
    const input = baseInput({
      content: { content: [{ category: 'section', children: [
        { category: 'datapoint', id: 1, schema_id: 'total', content: { value: '99', rir_confidence: 0.97 }, validation_sources: ['score'] },
        { category: 'multivalue', id: 'line_items', children: [
          { category: 'tuple', children: [{ category: 'datapoint', id: 10, schema_id: 'item_amount', content: { value: '5', rir_confidence: 0.6 }, validation_sources: ['score'] }] },
          { category: 'tuple', children: [{ category: 'datapoint', id: 11, schema_id: 'item_amount', content: { value: '7', rir_confidence: 0.95 }, validation_sources: ['score'] }] },
          { category: 'tuple', children: [{ category: 'datapoint', id: 12, schema_id: 'item_amount', content: { value: '9', rir_confidence: 0.5 }, validation_sources: ['score'] }] },
        ] },
      ] }] },
      schema: { content: [{ category: 'section', children: [
        { category: 'datapoint', id: 'total' },
        { category: 'multivalue', id: 'line_items', children: { category: 'tuple', children: [{ category: 'datapoint', id: 'item_amount', score_threshold: 0.9 }] } },
      ] }] },
    });
    const { items } = buildEvidence(input);
    const li = items.filter((i) => i.id === 'field:item_amount');
    expect(li).toHaveLength(1);                        // exactly one — no collision
    expect(li[0].data.lineItem).toBe(true);
    expect(li[0].data.cells).toBe(3);
    expect(li[0].data.below).toBe(2);                  // 0.6 and 0.5 are below the 0.9 field threshold
    expect(li[0].fact).toContain('3 cells');
    expect(items.find((i) => i.id === 'field:total')).toBeTruthy(); // scalar field unchanged
  });
  it('low_score threshold is UNIFIED between the verdict reason and the Blockers section (field threshold, not queue default)', () => {
    // Regression: computeVerdict used sample→field→queue-default, but explainBlocker (which
    // backs the Blockers-section item) used only sample→queue-default — so the VerdictCard
    // and the Blockers section showed DIFFERENT thresholds for the SAME blocker. Both must
    // now resolve to the per-field score_threshold (0.9), never the queue default (0.8).
    const input = baseInput({
      blocker: { content: [{ type: 'low_score', schema_id: 'recipient', samples: [{ datapoint_id: 5, details: { score: 0.5 } }] }] },
      schema: { content: [{ category: 'section', children: [{ category: 'datapoint', id: 'recipient', score_threshold: 0.9 }] }] },
    });
    const { items, verdict } = buildEvidence(input);
    const blockerItem = items.find((i) => i.id === 'blocker:0');
    expect(blockerItem.fact).toContain('0.9');
    expect(blockerItem.fact).not.toContain('0.8');   // was the queue default before the fix
    const reason = verdict.reasons.find((r) => r.evidenceId === 'blocker:0');
    expect(reason.fact).toContain('0.9');            // and the verdict reason agrees
  });
  it('unavailable enrichment produces an explicit gap item', () => {
    const input = baseInput({ enrichment: { workflow: [], notes: [], hookLogs: 'unavailable', ruleLogs: [] } });
    const gap = buildEvidence(input).items.find((i) => i.id === 'gap:hookLogs');
    expect(gap.reliability).toBe('unavailable');
  });

  it('live present → per-row drift items plus a summary item, all verified', () => {
    const input = baseInput({
      annotation: { id: 1, status: 'to_review', messages: [{ type: 'error', content: 'Removed one' }], labels: [] },
      live: { messages: [{ type: 'warning', content: 'Added one' }], matchedTriggerRules: [{ id: 5, name: 'R' }] },
    });
    const { items } = buildEvidence(input);
    const added = items.find((i) => i.id === 'drift:added:0');
    const removed = items.find((i) => i.id === 'drift:removed:0');
    const summary = items.find((i) => i.id === 'drift:summary');
    expect(added.section).toBe('drift');
    expect(added.reliability).toBe('verified');
    expect(added.fact).toContain('ADDS');
    expect(added.fact).toContain('Added one');
    expect(removed.section).toBe('drift');
    expect(removed.reliability).toBe('verified');
    expect(removed.fact).toContain('REMOVES');
    expect(removed.fact).toContain('Removed one');
    expect(summary.section).toBe('drift');
    expect(summary.reliability).toBe('verified');
    expect(summary.fact).toContain('1 message(s) added');
    expect(summary.fact).toContain('1 removed');
    expect(summary.fact).toContain('1 rule(s) matched');
  });

  it('live null → no drift items', () => {
    const input = baseInput();
    const { items } = buildEvidence(input);
    expect(items.some((i) => i.section === 'drift')).toBe(false);
  });
});
