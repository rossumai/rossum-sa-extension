// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import aiStyles from '../src/ui/aiInput.module.css';

// AgentBox imports extractFieldNames from JsonEditor — mock so CodeMirror isn't pulled in.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => null,
  extractFieldNames: () => ['vendor', 'amount'],
}));
// Drive the component through the loop's public entry points.
const runAgentQuery = vi.fn();
const continueAgentQuery = vi.fn();
vi.mock('../src/mdh/agent/agentQuery.js', () => ({
  runAgentQuery: (...a: any[]) => runAgentQuery(...a),
  continueAgentQuery: (...a: any[]) => continueAgentQuery(...a),
}));
// Capture transcript-modal opens.
const openModal = vi.fn();
vi.mock('../src/mdh/components/Modal.jsx', async (orig) => ({
  ...(await orig()),
  openModal: (...a: any[]) => openModal(...a),
}));
// Schema hints are fetched before the run — stub to avoid real API calls.
vi.mock('../src/mdh/agent/aiContext.js', () => ({
  getSchemaHints: vi.fn(async () => ({
    fieldTypes: {},
    numericStringFields: [],
    arrayPaths: [],
    knownValues: {},
    topValues: {},
    ranges: {},
    searchIndexes: [],
  })),
}));

import AgentBox, { TranscriptModal, outcomeFor } from '../src/mdh/components/AgentBox.jsx';
import * as store from '../src/mdh/store.js';

function waitFor(fn: any, { timeout = 1000, step = 10 } = {}) {
  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let ok = false;
      try {
        ok = fn();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(poll, step);
    })();
  });
}
const fireInput = (el: any, v: any) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const fireEnter = (el: any) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const editorRef = (setValue: any) => ({
  current: { setValue, getValue: () => '[{"$match":{"a":1}}]' },
});

let root: any;
beforeEach(() => {
  store.selectedCollection.value = 'invoices';
  store.records.value = [{ vendor: 'x', amount: 1 }];
  store.sampledFields.value = ['vendor', 'amount'];
  store.error.value = null;
  vi.clearAllMocks();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

describe('AgentBox (drop-in)', () => {
  it('applies the pipeline, forwards the current editor pipeline, and shows the result line + conversation modal', async () => {
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
    render(<AgentBox editorRef={editorRef(setValue)} />, root);
    // idle: the footer lifecycle slot is not rendered at all (and no attribution line)
    expect(root.querySelector('.agent-footer')).toBeNull();
    expect(root.textContent).not.toMatch(/Powered by/);
    const input: any = root.querySelector('input');
    fireInput(input, 'amounts over 10');
    fireEnter(input);

    await waitFor(() => setValue.mock.calls.length > 0);
    // applies the raw pipeline — NO "AI request" comment (the transcript modal carries that)
    expect(setValue.mock.calls[0][0]).toContain('"$match"');
    expect(setValue.mock.calls[0][0]).not.toContain('AI request');
    // iterate-on-existing: current editor pipeline forwarded to the loop
    expect(runAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        request: 'amounts over 10',
        collection: 'invoices',
        currentPipeline: '[{"$match":{"a":1}}]',
      }),
    );
    // done: the footer slot shows the compact result line (request + rows + verified)
    await waitFor(() => root.querySelector('.agent-result'));
    expect(root.querySelector('.agent-result-sum').textContent).toBe('amounts over 10');
    expect(root.textContent).toMatch(/3 rows · verified/);
    expect(root.querySelector('.agent-result-ok')).toBeTruthy();
    // conversation link opens the modal
    root.querySelector('.agent-transcript-link').click();
    expect(openModal).toHaveBeenCalledWith('Mr. Fabry — conversation', expect.any(Function));
  });

  it('does not touch the editor and puts the message in the result slot when no pipeline is produced', async () => {
    runAgentQuery.mockResolvedValue({ pipelineText: null, note: { kind: 'no-pipeline' } });
    const setValue = vi.fn();
    render(<AgentBox editorRef={editorRef(setValue)} />, root);
    const input: any = root.querySelector('input');
    fireInput(input, 'tell me a joke');
    fireEnter(input);

    await waitFor(() => root.querySelector('.agent-result-err'));
    expect(root.textContent).toMatch(/Couldn.t build a query/);
    expect(store.error.value).toBeNull(); // AI failures stay in the slot, not the global banner
    expect(setValue).not.toHaveBeenCalled();
  });

  it('shows a read-only message in the result slot and does not apply when a write is blocked', async () => {
    runAgentQuery.mockResolvedValue({ pipelineText: null, note: { kind: 'blocked' } });
    const setValue = vi.fn();
    render(<AgentBox editorRef={editorRef(setValue)} />, root);
    const input: any = root.querySelector('input');
    fireInput(input, 'delete all rows');
    fireEnter(input);

    await waitFor(() => root.querySelector('.agent-result-err'));
    expect(root.textContent).toMatch(/modify data|read-only/i);
    expect(store.error.value).toBeNull();
    expect(setValue).not.toHaveBeenCalled();
  });

  it('keeps the session-expired message on the global banner on a 401', async () => {
    runAgentQuery.mockRejectedValue(
      Object.assign(new Error('Session expired. Reconnect.'), { status: 401 }),
    );
    const setValue = vi.fn();
    render(<AgentBox editorRef={editorRef(setValue)} />, root);
    const input: any = root.querySelector('input');
    fireInput(input, 'x');
    fireEnter(input);

    await waitFor(() => store.error.value && /Session expired/.test(store.error.value.message));
    expect(root.querySelector('.agent-result')).toBeNull(); // no result line for a session-wide failure
    expect(setValue).not.toHaveBeenCalled();
  });

  it('shows the animated loader + live phase tracker while a query is in flight', async () => {
    let resolveRun: any;
    let emitPhase: any;
    runAgentQuery.mockImplementation(({ onPhase }) => {
      emitPhase = onPhase;
      return new Promise((r) => {
        resolveRun = r;
      });
    });
    render(<AgentBox editorRef={editorRef(vi.fn())} />, root);
    const input: any = root.querySelector('input');
    fireInput(input, 'slow query');
    fireEnter(input);

    await waitFor(
      () =>
        root.querySelector('input.' + aiStyles.loading) &&
        root.querySelector('.' + aiStyles.gerund),
    );
    // sparkle twinkles during the run
    expect(root.querySelector('.' + aiStyles.spark + '.' + aiStyles.loading)).toBeTruthy();
    // phase tracker starts with the 3 base steps (no Refine until one happens)
    await waitFor(() => root.querySelectorAll('.agent-phase').length === 3);
    await waitFor(() => typeof emitPhase === 'function'); // schema hints resolve before the loop starts
    emitPhase('generate');
    await waitFor(() => root.querySelector('.agent-phase.active')?.textContent === 'Generate');
    emitPhase('run');
    await waitFor(() => root.querySelector('.agent-phase.active')?.textContent === 'Run');
    // earlier steps read as done
    expect(root.querySelectorAll('.agent-phase.done').length).toBe(1);
    // a correction turn appends the honest 4th step
    emitPhase('refine');
    await waitFor(() => root.querySelectorAll('.agent-phase').length === 4);
    expect(root.querySelector('.agent-phase.active')?.textContent).toBe('Refine');

    resolveRun({ pipelineText: null, note: { kind: 'declined' } });
    await waitFor(() => !root.querySelector('input.' + aiStyles.loading));
    // tracker is replaced by the result line
    expect(root.querySelector('.agent-phases')).toBeNull();
    expect(root.querySelector('.agent-result')).toBeTruthy();
  });
});

describe('outcomeFor (result-line mapping)', () => {
  it('maps note kinds to the compact footer line', () => {
    expect(outcomeFor('q', { kind: 'verified', rowCount: 3 })).toEqual({
      ok: true,
      request: 'q',
      meta: '3 rows · verified',
    });
    expect(outcomeFor('q', { kind: 'refined', rowCount: 1 })).toEqual({
      ok: true,
      request: 'q',
      meta: '1 row · verified',
    });
    expect(outcomeFor('q', { kind: 'empty' })).toEqual({
      ok: true,
      request: 'q',
      meta: '0 matching rows',
    });
    expect(outcomeFor('q', { kind: 'unrun' })).toEqual({ ok: true, request: 'q', meta: 'applied' });
    expect(outcomeFor('q', { kind: 'error', error: 'boom' })).toEqual({
      ok: true,
      request: 'q',
      meta: 'applied · run failed',
    });
    expect(outcomeFor('q', { kind: 'blocked' }).ok).toBe(false);
    expect(outcomeFor('q', { kind: 'blocked' }).message).toMatch(/modify data/);
    expect(outcomeFor('q', { kind: 'no-pipeline' }).ok).toBe(false);
    expect(outcomeFor('q', null).ok).toBe(false);
  });
});

describe('TranscriptModal (continue the chat)', () => {
  it('renders prior turns and continues the existing chat, applying the refined pipeline', async () => {
    continueAgentQuery.mockResolvedValue({
      pipelineText: '[{"$match":{"amount":{"$gt":100}}}]',
      note: { kind: 'refined', rowCount: 2 },
      chatId: 'c1',
      transcript: [
        { role: 'user', text: 'orig' },
        { role: 'user', text: 'over 100' },
        { role: 'assistant', text: '[…]' },
      ],
    });
    const setValue = vi.fn();
    const onUpdate = vi.fn();
    const session = {
      chatId: 'c1',
      transcript: [{ role: 'user', text: 'orig request' }],
      ctx: { collection: 'invoices', fields: ['amount'], samples: [], hints: {} },
    };
    render(
      <TranscriptModal
        session={session}
        editorRef={{ current: { getValue: () => '[{"$match":{}}]', setValue } }}
        onUpdate={onUpdate}
      />,
      root,
    );

    expect(root.textContent).toMatch(/orig request/); // prior turn shown
    const input: any = root.querySelector('input');
    fireInput(input, 'over 100');
    fireEnter(input);

    await waitFor(() => setValue.mock.calls.length > 0);
    expect(continueAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', request: 'over 100', collection: 'invoices' }),
    );
    expect(setValue.mock.calls[0][0]).toContain('"$gt":100');
    expect(onUpdate).toHaveBeenCalled();
  });
});
