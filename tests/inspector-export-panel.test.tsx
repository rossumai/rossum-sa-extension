// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import ExportPanel from '../src/inspector/components/ExportPanel.jsx';
import * as store from '../src/inspector/store.js';

let root: any;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('ExportPanel AI attribution', () => {
  // Two export extensions, none named in the logs → genuinely ambiguous → AI block renders.
  const ambiguousExport = {
    annotation: { id: 1, status: 'failed_export', export_failed_at: 't' },
    resolved: { hooksById: {
      3: { id: 3, name: 'Exporter', type: 'function', events: ['annotation_content.export'], active: true },
      4: { id: 4, name: 'Backup', type: 'function', events: ['annotation_content.export'], active: true },
    } },
  };
  it('renders the orchestrator-fed export culprit + explanation when the failing hook is ambiguous (2+ export extensions)', () => {
    store.data.value = ambiguousExport;
    store.enrichment.value = { ...store.enrichment.value, hookLogs: [] };
    store.setAttribution('export', { status: 'done', verdict: { culprit: { kind: 'hook', id: 3, name: 'Exporter' }, confidence: 'medium', explanation: 'timed out posting to the ERP' }, source: 'ai' });
    render(<ExportPanel />, root);
    expect(root.textContent).toContain('Exporter');
    expect(root.textContent).toContain('timed out posting to the ERP');
  });
  it('does NOT render an AI block when there is no export extension (nothing to attribute)', () => {
    store.data.value = { annotation: { id: 1, status: 'failed_export', export_failed_at: 't' }, resolved: { hooksById: {} } };
    store.enrichment.value = { ...store.enrichment.value, hookLogs: [] };
    store.setAttribution('export', { status: 'done', verdict: { culprit: { kind: 'hook', id: 9, name: 'Ghost' }, confidence: 'low', explanation: 'x' }, source: 'ai' });
    render(<ExportPanel />, root);
    expect(root.textContent).toContain('no export extension found'); // verified path
    expect(root.textContent).not.toContain('Ghost'); // AI block suppressed (0 candidates)
  });
});
