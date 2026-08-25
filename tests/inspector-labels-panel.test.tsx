// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/inspector/index.jsx', () => ({ loadLabelContext: vi.fn() }));

import LabelsPanel from '../src/inspector/components/LabelsPanel.jsx';
import * as store from '../src/inspector/store.js';

function waitFor(fn: any, { timeout = 1000, step = 10 } = {}) {
  return new Promise<void>((res, rej) => { const t0 = Date.now(); (function p(){ let ok=false; try{ok=fn()}catch{} if(ok)return res(); if(Date.now()-t0>timeout)return rej(new Error('timeout')); setTimeout(p,step);})(); });
}
let root: any;
beforeEach(() => {
  store.aiAvailable.value = true;
  store.attributions.value = {};
  // one applied non-rule label (id 3) → agent-attributed
  store.data.value = { annotation: { labels: ['https://x/api/v1/labels/3'] }, resolved: { labelsById: { 3: { id: '3', name: 'Urgent', color: '#f00' } }, labelRules: [] } };
  vi.clearAllMocks();
  root = document.createElement('div'); document.body.appendChild(root);
});
afterEach(() => { render(null, root); root.remove(); });

describe('LabelsPanel AI attribution', () => {
  it('renders an applied non-rule label attribution seeded by the orchestrator', async () => {
    store.setAttribution('label:3', { status: 'done', verdict: { culprit: { kind: 'hook', id: 8, name: 'Labeler' }, confidence: 'medium', explanation: 'sets Urgent when total>1000' } });
    render(<LabelsPanel />, root);
    await waitFor(() => /Labeler/.test(root.textContent) && /sets Urgent/.test(root.textContent));
  });

  it('does not show AI attribution for a rule-applied label', async () => {
    store.data.value = {
      annotation: { labels: ['https://x/api/v1/labels/3'] },
      resolved: {
        labelsById: { 3: { id: '3', name: 'Urgent', color: '#f00' } },
        labelRules: [{ ruleId: 1, ruleName: 'Flag urgent', trigger: 'total > 1000', labelIds: ['3'] }],
      },
    };
    render(<LabelsPanel />, root);
    await waitFor(() => /Flag urgent/.test(root.textContent));
    expect(root.textContent).not.toMatch(/Labeler/);
  });

  it('shows an unavailable note when the agent is offline', async () => {
    store.aiAvailable.value = false;
    render(<LabelsPanel />, root);
    await waitFor(() => /unavailable/i.test(root.textContent));
  });

  it('shows the agent live activity (which tool it is calling) while attributing, not a static label', async () => {
    store.setAttribution('label:3', { status: 'loading', phase: 'reading extension logs' });
    render(<LabelsPanel />, root);
    await waitFor(() => /reading extension logs/.test(root.textContent));
    expect(root.textContent).not.toMatch(/reasoning…/);
  });
});
