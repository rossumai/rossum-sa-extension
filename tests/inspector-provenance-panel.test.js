// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import ProvenancePanel from '../src/inspector/components/ProvenancePanel.jsx';
import { fieldKey } from '../src/inspector/orchestrate.js';
import * as store from '../src/inspector/store.js';

let root;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('ProvenancePanel field attribution', () => {
  it('renders the attribution for a rules-sourced field', () => {
    store.data.value = { annotation: { id: 1 }, content: { content: [ { category: 'datapoint', schema_id: 'terms', content: { value: '2/10' }, validation_sources: ['rules'] } ] }, resolved: { hooksById: {} } };
    store.setAttribution(fieldKey('terms'), { status: 'done', verdict: { culprit: { kind: 'rule', id: 7, name: 'Set terms' }, confidence: 'medium', explanation: 'writes terms' }, source: 'ai' });
    render(h(ProvenancePanel, null), root);
    expect(root.textContent).toContain('Set terms');
  });
});
