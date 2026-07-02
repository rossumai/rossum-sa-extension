// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

// AgentBox imports extractFieldNames from JsonEditor — mock so CodeMirror isn't pulled in.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => null,
  extractFieldNames: () => ['vendor', 'amount'],
}));
// Drive the component through the loop's public entry points.
const runAgentQuery = vi.fn();
const continueAgentQuery = vi.fn();
vi.mock('../src/mdh/agent/agentQuery.js', () => ({
  runAgentQuery: (...a) => runAgentQuery(...a),
  continueAgentQuery: (...a) => continueAgentQuery(...a),
}));
// Capture transcript-modal opens.
const openModal = vi.fn();
vi.mock('../src/mdh/components/Modal.jsx', () => ({ openModal: (...a) => openModal(...a) }));
// Schema hints are fetched before the run — stub to avoid real API calls.
vi.mock('../src/mdh/agent/aiContext.js', () => ({
  getSchemaHints: vi.fn(async () => ({ fieldTypes: {}, numericStringFields: [], arrayPaths: [], knownValues: {}, topValues: {}, ranges: {}, searchIndexes: [] })),
}));

import AgentBox, { TranscriptModal } from '../src/mdh/components/AgentBox.jsx';
import * as store from '../src/mdh/store.js';

function waitFor(fn, { timeout = 1000, step = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let ok = false;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(poll, step);
    })();
  });
}
const fireInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const fireEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const editorRef = (setValue) => ({ current: { setValue, getValue: () => '[{"$match":{"a":1}}]' } });

let root;
beforeEach(() => {
  store.selectedCollection.value = 'invoices';
  store.records.value = [{ vendor: 'x', amount: 1 }];
  store.sampledFields.value = ['vendor', 'amount'];
  store.error.value = null;
  vi.clearAllMocks();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => { render(null, root); root.remove(); });

describe('AgentBox (drop-in)', () => {
  it('applies the pipeline (no inline note), forwards the current editor pipeline, and offers a transcript modal', async () => {
    runAgentQuery.mockResolvedValue({
      pipelineText: '[{"$match":{"amount":{"$gt":10}}}]',
      note: { kind: 'verified', rowCount: 3 },
      chatId: 'chat_test',
      transcript: [
        { role: 'user', text: 'amounts over 10' },
        { role: 'assistant', text: '[{"$match":{"amount":{"$gt":10}}}]' },
        { role: 'system', text: 'Ran the query — 3 rows' },
      ],
    });
    const setValue = vi.fn();
    render(h(AgentBox, { editorRef: editorRef(setValue) }), root);
    const input = root.querySelector('input');
    fireInput(input, 'amounts over 10');
    fireEnter(input);

    await waitFor(() => setValue.mock.calls.length > 0);
    // applies the raw pipeline — NO "AI request" comment (the transcript modal carries that)
    expect(setValue.mock.calls[0][0]).toContain('"$match"');
    expect(setValue.mock.calls[0][0]).not.toContain('AI request');
    // iterate-on-existing: current editor pipeline forwarded to the loop
    expect(runAgentQuery).toHaveBeenCalledWith(expect.objectContaining({
      request: 'amounts over 10', collection: 'invoices', currentPipeline: '[{"$match":{"a":1}}]',
    }));
    // no inline result note (the verdict text is not rendered in the box)
    expect(root.textContent).not.toMatch(/3 rows/);
    // transcript link opens the modal
    await waitFor(() => root.querySelector('.agent-transcript-link'));
    root.querySelector('.agent-transcript-link').click();
    expect(openModal).toHaveBeenCalledWith('Mr. Fabry — conversation', expect.any(Function));
  });

  it('does not touch the editor and surfaces a message when no pipeline is produced', async () => {
    runAgentQuery.mockResolvedValue({ pipelineText: null, note: { kind: 'no-pipeline' } });
    const setValue = vi.fn();
    render(h(AgentBox, { editorRef: editorRef(setValue) }), root);
    const input = root.querySelector('input');
    fireInput(input, 'tell me a joke');
    fireEnter(input);

    await waitFor(() => store.error.value && /Couldn.t build a query/.test(store.error.value.message));
    expect(setValue).not.toHaveBeenCalled();
  });

  it('surfaces a read-only message and does not apply when a write is blocked', async () => {
    runAgentQuery.mockResolvedValue({ pipelineText: null, note: { kind: 'blocked' } });
    const setValue = vi.fn();
    render(h(AgentBox, { editorRef: editorRef(setValue) }), root);
    const input = root.querySelector('input');
    fireInput(input, 'delete all rows');
    fireEnter(input);

    await waitFor(() => store.error.value && /modify data|read-only/i.test(store.error.value.message));
    expect(setValue).not.toHaveBeenCalled();
  });

  it('shows the session-expired message on a 401', async () => {
    runAgentQuery.mockRejectedValue(Object.assign(new Error('Session expired. Reconnect.'), { status: 401 }));
    const setValue = vi.fn();
    render(h(AgentBox, { editorRef: editorRef(setValue) }), root);
    const input = root.querySelector('input');
    fireInput(input, 'x');
    fireEnter(input);

    await waitFor(() => store.error.value && /Session expired/.test(store.error.value.message));
    expect(setValue).not.toHaveBeenCalled();
  });

  it('shows the animated loader while a query is in flight', async () => {
    let resolveRun;
    runAgentQuery.mockImplementation(() => new Promise((r) => { resolveRun = r; }));
    render(h(AgentBox, { editorRef: editorRef(vi.fn()) }), root);
    const input = root.querySelector('input');
    fireInput(input, 'slow query');
    fireEnter(input);

    await waitFor(() => root.querySelector('input.loading') && root.querySelector('.nl-search-loading'));
    resolveRun({ pipelineText: '[]', note: { kind: 'declined' } });
    await waitFor(() => !root.querySelector('input.loading'));
  });
});

describe('TranscriptModal (continue the chat)', () => {
  it('renders prior turns and continues the existing chat, applying the refined pipeline', async () => {
    continueAgentQuery.mockResolvedValue({
      pipelineText: '[{"$match":{"amount":{"$gt":100}}}]',
      note: { kind: 'refined', rowCount: 2 },
      chatId: 'c1',
      transcript: [{ role: 'user', text: 'orig' }, { role: 'user', text: 'over 100' }, { role: 'assistant', text: '[…]' }],
    });
    const setValue = vi.fn();
    const onUpdate = vi.fn();
    const session = { chatId: 'c1', transcript: [{ role: 'user', text: 'orig request' }], ctx: { collection: 'invoices', fields: ['amount'], samples: [], hints: {} } };
    render(h(TranscriptModal, { session, editorRef: { current: { getValue: () => '[{"$match":{}}]', setValue } }, onUpdate }), root);

    expect(root.textContent).toMatch(/orig request/); // prior turn shown
    const input = root.querySelector('input');
    fireInput(input, 'over 100');
    fireEnter(input);

    await waitFor(() => setValue.mock.calls.length > 0);
    expect(continueAgentQuery).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', request: 'over 100', collection: 'invoices' }));
    expect(setValue.mock.calls[0][0]).toContain('"$gt":100');
    expect(onUpdate).toHaveBeenCalled();
  });
});
