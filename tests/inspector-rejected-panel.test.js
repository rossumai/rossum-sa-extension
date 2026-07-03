// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/inspector/index.jsx', () => ({ loadEnrichment: vi.fn() }));

import RejectedPanel from '../src/inspector/components/RejectedPanel.jsx';
import * as store from '../src/inspector/store.js';

function waitFor(fn, { timeout = 1000, step = 10 } = {}) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function p(){ let ok=false; try{ok=fn()}catch{} if(ok)return res(); if(Date.now()-t0>timeout)return rej(new Error('timeout')); setTimeout(p,step);})(); });
}
let root;
beforeEach(() => {
  store.aiAvailable.value = true;
  store.attributions.value = {};
  store.enrichment.value = { workflow: [], notes: [], hookLogs: [] };
  store.data.value = { annotation: { id: 1, status: 'rejected', rejected_at: 't', automatically_rejected: true }, resolved: { usersById: {}, hooksById: {} } };
  vi.clearAllMocks();
  root = document.createElement('div'); document.body.appendChild(root);
});
afterEach(() => { render(null, root); root.remove(); });

describe('RejectedPanel AI attribution', () => {
  it('renders the culprit + confidence + explanation from an orchestrator-seeded verdict', async () => {
    store.setAttribution('reject', { status: 'done', verdict: { culprit: { kind: 'hook', id: 7, name: 'Rejector' }, confidence: 'high', explanation: 'calls reject() when total is 0' } });
    render(h(RejectedPanel, null), root);
    await waitFor(() => /Rejector/.test(root.textContent) && /calls reject/.test(root.textContent));
    expect(root.textContent).toMatch(/high confidence/i);
  });
  it('shows an unavailable note when the agent is offline', async () => {
    store.aiAvailable.value = false;
    render(h(RejectedPanel, null), root);
    await waitFor(() => /unavailable/i.test(root.textContent));
  });

  it('shows the agent live activity (which tool it is calling) while attributing, not a static label', async () => {
    store.setAttribution('reject', { status: 'loading', phase: 'reading extension logs' });
    render(h(RejectedPanel, null), root);
    await waitFor(() => /reading extension logs/.test(root.textContent));
    expect(root.textContent).not.toMatch(/Reasoning…/);
  });
});
