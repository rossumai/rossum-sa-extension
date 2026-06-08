// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { StageImporting, StageDone } from '../src/mdh/components/ImportStages.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

describe('ImportStages', () => {
  it('StageImporting shows progress percentage and inserted count', () => {
    const root = mount(h(StageImporting, {
      progress: { processed: 50, total: 100, inserted: 50, failedBatches: 0, phase: 'insert' },
      mode: 'insert', onCancel: () => {},
    }));
    expect(root.textContent).toContain('50%');
    expect(root.textContent).toContain('50 inserted');
  });

  it('StageDone shows the inserted total and filename', () => {
    const root = mount(h(StageDone, {
      result: { inserted: 12, deleted: 0, failedBatches: [], inFileDropped: 0, cancelled: false, kind: 'insert' },
      mode: 'insert', fileMeta: { name: 'vendors.csv' }, onClose: () => {},
    }));
    expect(root.textContent).toContain('Import complete');
    expect(root.textContent).toContain('vendors.csv');
    expect(root.textContent).toContain('12');
  });
});
