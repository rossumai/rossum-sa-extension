// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { ImportProgress, ImportSummary, formatBytes, formatDuration } from '../src/mdh/components/ImportStages.jsx';
import mstyles from '../src/ui/Modal.module.css';

function mount(node: any) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }

describe('ImportStages', () => {
  it('formatBytes formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('ImportProgress shows the phase label and percentage', () => {
    const root = mount(<ImportProgress progress={{ phase: 'update', processed: 5, total: 10 }} />);
    expect(root.textContent).toMatch(/Updating/);
    expect(root.textContent).toMatch(/5 \/ 10/);
    expect(root.textContent).toMatch(/50%/);
  });

  it('ImportSummary shows applied + inserted counts and the filename', () => {
    const root = mount(<ImportSummary
      result={{ kind: 'update', applied: 12, inserted: 3, deleted: 0, skipped: 0, failedBatches: [], cancelled: false }}
      fileMeta={{ name: 'vendors.csv' }}
      onClose={() => {}}
    />);
    expect(root.textContent).toMatch(/Updated/);
    expect(root.textContent).toMatch(/12/);
    expect(root.textContent).toMatch(/Inserted/);
    expect(root.textContent).toMatch(/vendors\.csv/);
  });

  it('ImportSummary marks a cancelled run', () => {
    const root = mount(<ImportSummary
      result={{ kind: 'insert', applied: 0, inserted: 4, deleted: 0, skipped: 0, failedBatches: [], cancelled: true }}
      fileMeta={{ name: 'x.json' }}
      onClose={() => {}}
    />);
    expect(root.textContent).toMatch(/Cancelled/);
  });

  it('ImportSummary shows the row range for a failed batch', () => {
    const root = mount(<ImportSummary
      result={{ kind: 'insert', applied: 0, inserted: 0, deleted: 0, skipped: 0, failedBatches: [{ startIdx: 0, endIdx: 999, count: 1000, message: 'batch op errors' }], cancelled: false }}
      fileMeta={{ name: 'x.json' }}
      onClose={() => {}}
    />);
    expect(root.textContent).toMatch(/Rows 0/);
    expect(root.textContent).toMatch(/batch op errors/);
  });
});

describe('formatDuration', () => {
  it('formats milliseconds as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5000)).toBe('0:05');
    expect(formatDuration(83_000)).toBe('1:23');
    expect(formatDuration(null)).toBe('0:00');
  });
});

describe('ImportProgress indeterminate', () => {
  it('renders a processing message and no numeric counts when indeterminate', () => {
    const root = mount(<ImportProgress progress={{ phase: 'processing', indeterminate: true }} />);
    expect(root.textContent).toMatch(/processing/i);
    expect(root.querySelector('.import-progress-counts')).toBeNull();
  });

  it('shows a live heartbeat (status, check count, elapsed, file) when the server poll info is present', () => {
    const root = mount(<ImportProgress
      progress={{ phase: 'processing', indeterminate: true, status: 'processing', checks: 12, elapsedMs: 42_000, file: { filename: 'data.json', size: 30715 } }}
      onCancel={() => {}}
    />);
    const line = root.querySelector('[data-testid="import-progress-status"]')!;
    expect(line).toBeTruthy();
    expect(line.textContent).toMatch(/status: processing/);
    expect(line.textContent).toMatch(/checked 12/);
    expect(line.textContent).toMatch(/0:42 elapsed/);
    expect(root.textContent).toMatch(/data\.json/);
    expect(root.textContent).toMatch(/30\.0 KB/); // file size shown (30715 B → 30.0 KB)
    // The stop-watching affordance reads as leaving, not killing the job.
    expect([...root.querySelectorAll('.' + mstyles.actions + ' button')].some((b) => /stop watching/i.test(b.textContent))).toBe(true);
  });
});

describe('ImportSummary server-managed', () => {
  it('shows the uploaded row count for a server-managed update', () => {
    const root = mount(<ImportSummary
      result={{ kind: 'update', sent: 42, serverManaged: true, ok: true, failedBatches: [] }}
      fileMeta={{ name: 'f.json' }}
      onClose={() => {}}
    />);
    expect(root.textContent).toMatch(/42/);
    expect(root.textContent).toMatch(/updated|upsert/i);
  });

  it('marks a cancelled server-managed run without saying it failed', () => {
    const root = mount(<ImportSummary
      result={{ kind: 'replace', sent: 3, serverManaged: true, ok: false, cancelled: true, failedBatches: [] }}
      fileMeta={{ name: 'f.json' }}
      onClose={() => {}}
    />);
    expect(root.textContent).toMatch(/Cancelled/i);
    expect(root.textContent).toMatch(/background/i);
    expect(root.textContent).not.toMatch(/failed/i);
  });
});
