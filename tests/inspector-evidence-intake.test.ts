import { describe, it, expect } from 'vitest';
import { intakeEvidence, workflowEvidence, arrivalLabel } from '../src/inspector/evidence.js';

describe('arrivalLabel (compact Intake header, not the raw attachment_status)', () => {
  it('maps verified statuses to short human labels', () => {
    expect(arrivalLabel(null)).toBe('upload');
    expect(arrivalLabel('processed')).toBe('email attachment'); // not the raw "processed"
    expect(arrivalLabel('extracted_archive')).toBe('archive');
    expect(arrivalLabel('hook_failed')).toBe('import (hook failed)');
  });
  it('falls back to the raw value for an unknown status', () => {
    expect(arrivalLabel('some_future_status')).toBe('some_future_status');
  });
});

const base = { annotation: { id: 1 }, document: null, parentDocument: null, relations: [], email: null, workflowRuns: [], workflowSteps: [], enrichment: {} };

describe('intakeEvidence', () => {
  it('classifies arrival by attachment_status (verified vocabulary)', () => {
    const cases = [
      [null, /uploaded directly/i],
      ['processed', /email attachment/i],
      ['extracted_archive', /archive/i],
    ];
    for (const [status, re] of cases) {
      const items = intakeEvidence({ ...base, document: { attachment_status: status, arrived_at: '2026-07-01T09:14:00Z' } });
      expect(items.find((i) => i.id === 'intake:arrival').fact).toMatch(re!);
    }
  });
  it('split parent produces intake:split with the parent file name', () => {
    const items = intakeEvidence({ ...base,
      document: { parent: 'https://x/api/v1/documents/50', attachment_status: null },
      parentDocument: { id: 50, original_file_name: 'batch_scan.pdf' } });
    expect(items.find((i) => i.id === 'intake:split').fact).toContain('batch_scan.pdf');
  });
  it('duplicate relation lists sibling annotation ids, edit relations ignored', () => {
    const items = intakeEvidence({ ...base, relations: [
      { type: 'edit', annotations: [] },
      { type: 'duplicate', annotations: ['https://x/api/v1/annotations/1', 'https://x/api/v1/annotations/2'] },
    ] });
    const dup = items.find((i) => i.id === 'intake:duplicate');
    expect(dup.fact).toContain('2 annotation(s)');
    expect(dup.fact).toContain('1, 2');
    expect(items.filter((i) => i.fact.match(/edit/i))).toHaveLength(0);
  });
  it('email with unknown shape degrades honestly', () => {
    const items = intakeEvidence({ ...base, document: { attachment_status: 'processed', email: 'https://x/api/v1/emails/9' }, email: {} });
    const arr = items.find((i) => i.id === 'intake:arrival');
    expect(arr.fact).toMatch(/email attachment/i);
    expect(arr.fact).not.toMatch(/undefined/);
  });
});

describe('workflowEvidence', () => {
  it('no runs → empty (section renders n/a)', () => {
    expect(workflowEvidence(base)).toHaveLength(0);
  });
  it('run + steps + assignee activity', () => {
    const items = workflowEvidence({ ...base,
      workflowRuns: [{ id: 10, workflow_status: 'in_review', current_step: 'https://x/api/v1/workflow_steps/3', workflow: 'https://x/api/v1/workflows/5' }],
      workflowSteps: [
        { id: 2, url: 'https://x/api/v1/workflow_steps/2', name: 'Team lead', ordering: 1, mode: 'any' },
        { id: 3, url: 'https://x/api/v1/workflow_steps/3', name: 'Finance', ordering: 2, mode: 'all' },
      ],
      enrichment: { workflow: [{ action: 'step_started', workflow_step: 'https://x/api/v1/workflow_steps/3', assignees: ['https://x/api/v1/users/77'] }] },
    });
    const run = items.find((i) => i.id === 'workflow:run');
    expect(run.fact).toContain('in_review');
    expect(run.fact).toContain('Finance');
    const step = items.find((i) => i.id === 'workflow:step:3');
    expect(step.data.current).toBe(true);
    expect(step.data.assignees).toEqual(['77']);
  });
  it('assignees come from the latest step_started activity by created_at, not array order', () => {
    const items = workflowEvidence({ ...base,
      workflowRuns: [{ id: 10, workflow_status: 'in_review', current_step: 'https://x/api/v1/workflow_steps/3', workflow: 'https://x/api/v1/workflows/5' }],
      workflowSteps: [
        { id: 3, url: 'https://x/api/v1/workflow_steps/3', name: 'Finance', ordering: 1, mode: 'all' },
      ],
      enrichment: { workflow: [
        // Newer activity listed FIRST, older listed LAST — proves created_at wins, not array position.
        { action: 'step_started', workflow_step: 'https://x/api/v1/workflow_steps/3', assignees: ['https://x/api/v1/users/77'], created_at: '2026-07-02T00:00:00Z' },
        { action: 'step_started', workflow_step: 'https://x/api/v1/workflow_steps/3', assignees: ['https://x/api/v1/users/1'], created_at: '2026-07-01T00:00:00Z' },
      ] },
    });
    const step = items.find((i) => i.id === 'workflow:step:3');
    expect(step.data.assignees).toEqual(['77']);
  });
});
