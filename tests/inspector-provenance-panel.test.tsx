// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import ProvenancePanel from '../src/inspector/components/ProvenancePanel.jsx';
import { fieldKey } from '../src/inspector/orchestrate.js';
import * as store from '../src/inspector/store.js';

let root: any;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('ProvenancePanel field attribution', () => {
  it('renders the attribution for a rules-sourced field', () => {
    store.data.value = { annotation: { id: 1 }, content: { content: [ { category: 'datapoint', schema_id: 'terms', content: { value: '2/10' }, validation_sources: ['rules'] } ] }, resolved: { hooksById: {} } };
    store.setAttribution(fieldKey('terms'), { status: 'done', verdict: { culprit: { kind: 'rule', id: 7, name: 'Set terms' }, confidence: 'medium', explanation: 'writes terms' }, source: 'ai' });
    render(<ProvenancePanel />, root);
    expect(root.textContent).toContain('Set terms');
  });

  it('renders a confidence bar with threshold for engine fields', () => {
    store.data.value = {
      annotation: { id: 1 },
      content: { content: [ { category: 'datapoint', schema_id: 'terms', content: { value: '2/10', rir_confidence: 0.31 }, validation_sources: ['score'] } ] },
      resolved: { hooksById: {}, schema: { content: [ { category: 'datapoint', id: 'terms', score_threshold: 0.8 } ] }, queue: null },
    };
    render(<ProvenancePanel />, root);
    const el: any = root.querySelector('.inspector-table');
    expect(el.querySelector('.inspector-conf')).toBeTruthy();
    expect(el.textContent).toContain('0.31');
    expect(el.querySelector('.inspector-conf').getAttribute('title')).toMatch(/tick marks the automation threshold/i);
  });

  it('clamps a malformed out-of-range confidence to the bar track', () => {
    store.data.value = {
      annotation: { id: 1 },
      content: { content: [ { category: 'datapoint', schema_id: 'terms', content: { value: 'x', rir_confidence: 1.4 }, validation_sources: ['score'] } ] },
      resolved: { hooksById: {}, schema: null, queue: { default_score_threshold: 0.8 } },
    };
    render(<ProvenancePanel />, root);
    const fill: any = root.querySelector('.inspector-conf i');
    expect(fill.getAttribute('style')).toMatch(/width:\s*100%/);
  });
});
