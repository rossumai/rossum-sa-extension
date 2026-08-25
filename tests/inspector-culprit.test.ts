// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  REL,
  classifyMessage,
  explainBlocker,
  classifyRejection,
  fieldProvenance,
  extractLabelRules,
  labelAttribution,
  exportHookCandidates,
  matchingExtensions,
  contrastText,
  matchConfigsForField,
  buildPipeline,
} from '../src/inspector/culprit.js';

describe('classifyMessage', () => {
  it('attributes a hook exception to its hook', () => {
    const m = classifyMessage({
      type: 'error',
      content: 'HostNotFound',
      detail: {
        hook_id: 1791439,
        hook_name: 'Pre: Duplicate detector',
        request_id: 'r1',
        is_exception: true,
      },
    });
    expect(m).toMatchObject({
      level: 'error',
      isException: true,
      requestId: 'r1',
      datapointId: null,
      culprit: { kind: 'hook', id: 1791439, name: 'Pre: Duplicate detector' },
      reliability: REL.VERIFIED,
    });
  });
  it('attributes a rule message to its rule and captures datapoint id', () => {
    const m = classifyMessage({
      type: 'warning',
      content: 'X',
      id: '18584171175',
      detail: {
        rule_id: 234,
        rule_name: 'Amount cross-check',
        hook_id: null,
        hook_name: 'rules',
        is_exception: false,
      },
    });
    expect(m.culprit).toEqual({ kind: 'rule', id: 234, name: 'Amount cross-check' });
    expect(m.datapointId).toBe('18584171175');
    expect(m.isException).toBe(false);
  });
  it('marks an unattributable message unavailable, never guesses', () => {
    const m = classifyMessage({ type: 'info', content: 'legacy', detail: {} });
    expect(m.culprit).toBe(null);
    expect(m.reliability).toBe(REL.UNAVAILABLE);
  });
});

describe('explainBlocker', () => {
  const ctx = {
    queue: { automation_level: 'never', default_score_threshold: 0.8 },
    schemaById: {},
  };
  it('explains low_score with score vs threshold and blames the engine', () => {
    const b = explainBlocker(
      {
        type: 'low_score',
        level: 'datapoint',
        schema_id: 'recipient_name',
        samples: [{ datapoint_id: 1, details: { score: 0.58, threshold: 0.8 } }],
      },
      ctx,
    );
    expect(b.schemaId).toBe('recipient_name');
    expect(b.culprit).toEqual({ kind: 'engine', id: null, name: 'extraction engine' });
    expect(b.explanation).toMatch(/0\.58.*0\.8/);
    expect(b.reliability).toBe(REL.VERIFIED);
  });
  it('blames the queue config for automation_disabled', () => {
    const b = explainBlocker({ type: 'automation_disabled', level: 'annotation' }, ctx);
    expect(b.culprit!.kind).toBe('queue');
    expect(b.explanation).toMatch(/never/);
  });
  it('reads producer name from details.detail[0].rule_name (best-effort)', () => {
    const b = explainBlocker(
      {
        type: 'failed_checks',
        level: 'datapoint',
        schema_id: 'x',
        details: { detail: [{ rule_name: 'My Rule' }] },
      },
      ctx,
    );
    expect(b.culprit).toEqual({ kind: 'rule', id: null, name: 'My Rule' });
    expect(b.reliability).toBe(REL.BEST_EFFORT);
  });
  it('renders unknown blocker types gracefully', () => {
    const b = explainBlocker({ type: 'some_future_type', level: 'annotation' }, ctx);
    expect(b.type).toBe('some_future_type');
    expect(b.explanation).toBeTruthy();
    expect(b.culprit).toBe(null);
  });
});

describe('classifyRejection', () => {
  it('manual: blames the user from rejected_by, reason from notes', () => {
    const r = classifyRejection({
      annotation: {
        status: 'rejected',
        rejected_at: 'T',
        rejected_by: 'https://h/api/v1/users/7',
        automatically_rejected: false,
      },
      workflowActivities: [],
      notes: [{ type: 'rejection', content: 'dup', creator: 'https://h/api/v1/users/7' }],
      usersById: { 7: { username: 'jr@acme.com' } },
    });
    expect(r.current).toBe(true);
    expect(r.type).toBe('manual');
    expect(r.culprit).toMatchObject({ kind: 'user', name: 'jr@acme.com' });
    expect(r.reason).toEqual({ text: 'dup', reliability: REL.VERIFIED });
  });
  it('workflow: blames the workflow even though automatically_rejected is false', () => {
    const r = classifyRejection({
      annotation: {
        status: 'confirmed',
        rejected_at: 'T',
        rejected_by: null,
        automatically_rejected: false,
      },
      workflowActivities: [
        { action: 'rejected', note: 'no step matched', workflow: 'https://h/api/v1/workflows/35' },
      ],
      notes: [],
    });
    expect(r.historical).toBe(true);
    expect(r.type).toBe('workflow');
    expect(r.culprit).toMatchObject({ kind: 'workflow', id: '35' });
    expect(r.reason.text).toBe('no step matched');
  });
  it('hook: automatically_rejected true + service identity, exact extension best-effort', () => {
    const r = classifyRejection({
      annotation: {
        status: 'rejected',
        rejected_at: 'T',
        rejected_by: 'https://h/api/v1/users/9',
        automatically_rejected: true,
      },
      workflowActivities: [],
      notes: [],
      usersById: { 9: { username: 'svc-bot' } },
    });
    expect(r.type).toBe('hook');
    expect(r.culprit).toMatchObject({ kind: 'extension', name: 'svc-bot' });
    expect(r.reliability).toBe(REL.BEST_EFFORT);
  });
  it('not rejected', () => {
    const r = classifyRejection({
      annotation: { status: 'to_review', rejected_at: null },
      workflowActivities: [],
      notes: [],
    });
    expect(r.type).toBe('none');
    expect(r.current).toBe(false);
    expect(r.historical).toBe(false);
  });
});

describe('labels', () => {
  it('extractLabelRules pulls label refs from any label-named payload key (enabled rules/actions only)', () => {
    const rules = [
      {
        id: 7,
        name: 'Tag high value',
        enabled: true,
        trigger_condition: 'field.amount_total > 10000',
        actions: [
          { enabled: true, type: 'add_label', payload: { label: 'https://h/v1/labels/9898' } },
        ],
      },
      {
        id: 8,
        name: 'disabled',
        enabled: false,
        actions: [{ enabled: true, payload: { labels: ['https://h/v1/labels/1'] } }],
      },
      {
        id: 9,
        name: 'no labels',
        enabled: true,
        actions: [{ enabled: true, type: 'show_message', payload: { content: 'x' } }],
      },
    ];
    const lr = extractLabelRules(rules);
    expect(lr.length).toBe(1);
    expect(lr[0]).toMatchObject({
      ruleId: 7,
      ruleName: 'Tag high value',
      trigger: 'field.amount_total > 10000',
      labelIds: ['9898'],
    });
  });

  it('labelAttribution: applied-by-rule, applied-manually, governed-not-applied', () => {
    const labelsById = {
      9898: { id: '9898', name: 'Priority: High', color: '#f00' },
      9905: { id: '9905', name: 'Duplicate suspected' },
      9901: { id: '9901', name: 'Needs review' },
    };
    const labelRules = [
      {
        ruleId: 7,
        ruleName: 'Tag high value',
        trigger: 'field.amount_total > 10000',
        labelIds: ['9898'],
      },
      { ruleId: 8, ruleName: 'Flag dupes', trigger: 'not is_empty(field.dup)', labelIds: ['9905'] },
    ];
    const annotation = { labels: ['https://h/v1/labels/9898', 'https://h/v1/labels/9901'] };
    const { applied, notApplied } = labelAttribution({ annotation, labelsById, labelRules });
    expect(applied.find((l: any) => l.id === '9898')).toMatchObject({
      name: 'Priority: High',
      rule: { name: 'Tag high value' },
      reliability: REL.VERIFIED,
    });
    const manual = applied.find((l: any) => l.id === '9901');
    expect(manual.rule).toBe(null);
    expect(manual.reliability).toBe(REL.UNAVAILABLE);
    expect(notApplied).toHaveLength(1);
    expect(notApplied[0]).toMatchObject({
      id: '9905',
      name: 'Duplicate suspected',
      rule: { name: 'Flag dupes' },
    });
  });
});

describe('extension run timeline', () => {
  it('exportHookCandidates: lists export hooks + matches the failing one from logs', () => {
    const ehooks = [
      {
        id: 70,
        name: 'Export: ERP push',
        type: 'webhook',
        active: true,
        events: ['annotation_content.export'],
      },
      {
        id: 71,
        name: 'Export: Slack',
        type: 'webhook',
        active: true,
        events: ['annotation_content.export'],
      },
      {
        id: 72,
        name: 'Pre: validator',
        type: 'function',
        active: true,
        events: ['annotation_content.started'],
      },
    ];
    const both = exportHookCandidates(ehooks, []);
    expect(both.candidates.map((c) => c.hookId).sort()).toEqual([70, 71]);
    expect(both.failing).toBe(null);
    const withLog = exportHookCandidates(ehooks, [
      { hook_id: 70, action: 'export', status: 'failed', message: '502 Bad Gateway' },
    ]);
    expect(withLog.failing).toMatchObject({
      hookId: 70,
      hookName: 'Export: ERP push',
      error: '502 Bad Gateway',
    });
  });

  it('buildPipeline orders by run_after, groups by phase, overlays logs, drops inactive', () => {
    const hooks = [
      {
        id: 1,
        name: 'A init',
        type: 'function',
        active: true,
        events: ['annotation_content.initialize'],
        run_after: [],
      },
      {
        id: 2,
        name: 'B init',
        type: 'function',
        active: true,
        events: ['annotation_content.initialize'],
        run_after: ['https://h/v1/hooks/1'],
      },
      {
        id: 3,
        name: 'Inactive',
        type: 'function',
        active: false,
        events: ['annotation_content.initialize'],
        run_after: [],
      },
      {
        id: 4,
        name: 'Export push',
        type: 'webhook',
        active: true,
        events: ['annotation_content.export'],
        run_after: [],
      },
    ];
    const logs = [
      {
        hook_id: 4,
        action: 'export',
        status: 'failed',
        log_level: 'ERROR',
        message: '502',
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T00:00:00.020Z',
        status_code: 0,
      },
    ];
    const phases = buildPipeline(hooks, logs);
    const init = phases.find((p) => p.event === 'annotation_content.initialize')!;
    expect(init.nodes.map((n) => n.hookId)).toEqual([1, 2]); // B run_after A; inactive dropped
    expect(init.nodes[0].run).toBe(null); // no log -> not "didn't run"
    const exp = phases.find((p) => p.event === 'annotation_content.export')!;
    expect(exp.nodes[0]).toMatchObject({ hookId: 4 });
    expect(exp.nodes[0].run).toMatchObject({ failed: true, message: '502', durationMs: 20 });
  });
});

describe('provenance', () => {
  it('buckets a field value to its primary validation source (verified values)', () => {
    const p = fieldProvenance({
      schema_id: 'amount_total',
      validation_sources: ['score'],
      content: { value: '5', rir_confidence: 0.97 },
    });
    expect(p).toMatchObject({ schemaId: 'amount_total', primary: 'score', confidence: 0.97 });
    const h = fieldProvenance({
      schema_id: 'x',
      validation_sources: ['score', 'human'],
      content: { value: 'a' },
    });
    expect(h.primary).toBe('human');
    // data_matching is a real source; non_required is a flag and never primary
    const dm = fieldProvenance({
      schema_id: 'y',
      validation_sources: ['data_matching', 'non_required'],
      content: { value: 'b' },
    });
    expect(dm.primary).toBe('data_matching');
    const none = fieldProvenance({
      schema_id: 'z',
      validation_sources: [],
      content: { value: 'c' },
    });
    expect(none.primary).toBe('none');
    // full verified source set: human > data_matching > connector > rules > formula > score
    expect(
      fieldProvenance({ schema_id: 'a', validation_sources: ['score', 'formula'], content: {} })
        .primary,
    ).toBe('formula');
    expect(
      fieldProvenance({ schema_id: 'b', validation_sources: ['connector'], content: {} }).primary,
    ).toBe('connector');
    expect(
      fieldProvenance({ schema_id: 'c', validation_sources: ['rules', 'score'], content: {} })
        .primary,
    ).toBe('rules');
    expect(
      fieldProvenance({ schema_id: 'd', validation_sources: ['NA'], content: {} }).primary,
    ).toBe('none');
  });

  it('matchingExtensions finds MDH/matching hooks (settings.configurations | configs)', () => {
    const hooks = [
      { id: 1, name: 'Master Data Hub', settings: { configurations: [{}] } },
      { id: 2, name: 'Legacy MDH', settings: { configs: [{}] } },
      { id: 3, name: 'Other', settings: {} },
    ];
    expect(
      matchingExtensions(hooks)
        .map((x) => x.hookId)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('matchConfigsForField pins a data_matching field to the specific MDH config (not every MDH hook)', () => {
    const hooks = [
      {
        id: 1,
        name: 'Master Data Hub',
        settings: {
          configurations: [
            { name: 'Supplier match', mapping: { target_schema_id: 'sender_match' } },
            {
              name: 'GL multi',
              mapping: { target_schema_id: 'item_gl' },
              additional_mappings: [{ dataset_key: 'cc', target_schema_id: 'item_cost_center' }],
            },
          ],
        },
      },
      {
        id: 2,
        name: 'Other MDH',
        settings: { configs: [{ name: 'legacy', mapping: { target_schema_id: 'vat_code' } }] },
      },
      { id: 3, name: 'Not a matcher', settings: {} },
    ];
    expect(matchConfigsForField('sender_match', hooks)).toEqual([
      { hookId: 1, hookName: 'Master Data Hub', configName: 'Supplier match' },
    ]);
    // additional (multi-field) mapping target is found
    expect(matchConfigsForField('item_cost_center', hooks)).toEqual([
      { hookId: 1, hookName: 'Master Data Hub', configName: 'GL multi' },
    ]);
    // legacy settings.configs
    expect(matchConfigsForField('vat_code', hooks)).toEqual([
      { hookId: 2, hookName: 'Other MDH', configName: 'legacy' },
    ]);
    // a field no config targets -> empty (precise: nothing claims it)
    expect(matchConfigsForField('unknown_field', hooks)).toEqual([]);
  });

  it('contrastText picks readable text over a label color', () => {
    expect(contrastText('#111111')).toBe('#ffffff'); // dark bg -> white text
    expect(contrastText('#FFFF00')).toBe('#1a1a24'); // bright bg -> dark text
    expect(contrastText('bogus')).toBe('#ffffff');
  });
});
