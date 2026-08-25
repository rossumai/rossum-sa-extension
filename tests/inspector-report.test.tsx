// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import Report from '../src/inspector/components/Report.jsx';

function mount() { const el = document.createElement('div'); render(<Report />, el); return el; }

function baseAnnotation() {
  return { annotation: { id: 9, status: 'to_review', messages: [], labels: [], created_at: '2026-07-01T09:00:00Z' }, blocker: { content: [] }, content: { content: [] }, resolved: { usersById: {}, hooksById: {}, labelsById: {}, labelRules: [], queue: null, schema: null, document: null, _hooksLoaded: true, _workflowLoaded: true, _intakeLoaded: true } };
}

beforeEach(() => {
  store.attributions.value = {};
  store.enrichment.value = { audit: null, hookLogs: [], ruleLogs: null, workflow: [], notes: [] };
  store.evidence.value = { items: [], verdict: { state: 'in-review', severity: 'warning', headline: 'In review', reasons: [] } };
  store.investigation.value = { stage: 'gathering', sourcesDone: 1, sourcesTotal: 9, activity: '' };
});

describe('Report', () => {
  it('assembles header, strip, verdict, diagnosis and all sections in order', () => {
    store.data.value = baseAnnotation();
    const el = mount();
    const text = el.textContent;
    expect(el.querySelector('.inspector-rephead')).toBeTruthy();
    expect(el.querySelector('.inspector-inv')).toBeTruthy();
    expect(el.querySelector('.inspector-verdict')).toBeTruthy();
    expect(el.querySelector('.inspector-diag')).toBeTruthy();
    for (const t of ['Intake & origin', 'Blockers & messages', 'Fields', 'Extension runs', 'Labels', 'Rejection', 'Approval workflow', 'Export', 'Config drift']) {
      expect(text).toContain(t);
    }
  });

  it('Extension runs section is pending while hookLogs is null and hooks have not loaded', () => {
    store.data.value = baseAnnotation();
    store.data.value.resolved._hooksLoaded = false;
    store.enrichment.value = { ...store.enrichment.value, hookLogs: null };
    const el = mount();
    const section = el.querySelector('[data-evidence-section="pipeline"]');
    expect(section!.querySelector('.inspector-sst-pending')).toBeTruthy();
  });

  it('Extension runs section reports unavailable/sparse once hooks are loaded', () => {
    store.data.value = baseAnnotation();
    store.enrichment.value = { ...store.enrichment.value, hookLogs: 'unavailable' };
    let el = mount();
    let section = el.querySelector('[data-evidence-section="pipeline"]');
    expect(section!.querySelector('.inspector-sst-unavailable')).toBeTruthy();

    store.enrichment.value = { ...store.enrichment.value, hookLogs: [] };
    el = mount();
    section = el.querySelector('[data-evidence-section="pipeline"]');
    expect(section!.querySelector('.inspector-sst-sparse')).toBeTruthy();
  });

  it('Labels section is pending while labelsById is undefined', () => {
    store.data.value = baseAnnotation();
    store.data.value.resolved.labelsById = undefined;
    const el = mount();
    const section = el.querySelector('[data-evidence-section="labels"]');
    expect(section!.querySelector('.inspector-sst-pending')).toBeTruthy();
  });

  it('Labels section is attributing/loaded once labelsById resolves', () => {
    store.data.value = baseAnnotation();
    const el = mount();
    const section = el.querySelector('[data-evidence-section="labels"]');
    expect(section!.querySelector('.inspector-sst-loaded')).toBeTruthy();
  });

  it('Rejection section is pending while workflow or notes enrichment is null', () => {
    store.data.value = baseAnnotation();
    store.enrichment.value = { ...store.enrichment.value, workflow: null };
    let el = mount();
    let section = el.querySelector('[data-evidence-section="rejection"]');
    expect(section!.querySelector('.inspector-sst-pending')).toBeTruthy();

    store.enrichment.value = { ...store.enrichment.value, workflow: [], notes: null };
    el = mount();
    section = el.querySelector('[data-evidence-section="rejection"]');
    expect(section!.querySelector('.inspector-sst-pending')).toBeTruthy();
  });

  it('Rejection section falls back to na once workflow + notes have loaded and no rejection evidence exists', () => {
    store.data.value = baseAnnotation();
    const el = mount();
    const section = el.querySelector('[data-evidence-section="rejection"]');
    expect(section!.querySelector('.inspector-sst-na')).toBeTruthy();
  });
});
