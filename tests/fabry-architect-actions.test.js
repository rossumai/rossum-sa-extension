// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/agent/agentApi.js', () => ({ createChat: vi.fn(), streamMessage: vi.fn() }));
vi.mock('../src/fabry/architect/api.js', () => ({
  COLLECTION: '_SA_EXTENSION__fabry_architect',
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  // Boot now resolves WHICH collection this org uses before reading it (collectionPlan.js).
  resolveCollection: vi.fn().mockResolvedValue({ use: '_SA_EXTENSION__fabry_architect', legacy: null, action: 'none', migrated: false }),
  listRevisions: vi.fn().mockResolvedValue({ result: [] }),
  getRevision: vi.fn().mockResolvedValue({ result: [] }),
  addRevision: vi.fn().mockResolvedValue({}),
  deleteRevisions: vi.fn().mockResolvedValue({}),
  deleteRevisionsFor: vi.fn().mockResolvedValue({}),
  loadDeliverables: vi.fn().mockResolvedValue({ deliverables: [], results: {} }),
  addDeliverable: vi.fn().mockResolvedValue({}),
  updateDeliverable: vi.fn().mockResolvedValue({}),
  deleteDeliverable: vi.fn().mockResolvedValue({}),
  saveResult: vi.fn().mockResolvedValue({}),
  setOrder: vi.fn().mockResolvedValue({}),
  saveTitle: vi.fn().mockResolvedValue({}),
}));
import * as agentApi from '../src/agent/agentApi.js';
import * as api from '../src/fabry/architect/api.js';
import * as store from '../src/fabry/architect/store.js';
import {
  loadArchitect, addDeliverable, openDeliverable, updateDeliverable, deleteDeliverable, runAll, reorder,
  moveDeliverable, refineTurn, answerRefine, renameDeliverable, generateTitle, backfillTitles,
} from '../src/fabry/architect/actions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
function scriptReplies(map) {
  let n = 0;
  agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
  agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
    if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
    const key = Object.keys(map).find((k) => content.includes(k)) || '';
    onEvent({ type: 'text-delta', delta: map[key] || 'VERDICT: UNCERTAIN' });
    onEvent({ type: 'finish' });
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = []; store.results.value = {}; store.activeId.value = null;
  store.implement.value = {};
  store.loaded.value = false; store.loadError.value = null; store.running.value = false;
});

describe('loadArchitect', () => {
  it('loads deliverables + persisted (stale) results', async () => {
    api.loadDeliverables.mockResolvedValueOnce({ deliverables: [{ id: 'a', text: '# A', order: 1 }], results: { a: { verdict: 'pass', evidence: 'ok', chatId: 'c', ranAt: 5, stale: true } } });
    await loadArchitect();
    expect(api.resolveCollection).toHaveBeenCalled();
    expect(store.deliverables.value.length).toBe(1);
    expect(store.results.value.a.stale).toBe(true);
    expect(store.loaded.value).toBe(true);
  });
  it('rehydrates persisted implement-loop state (status / tasks / write audit)', async () => {
    api.loadDeliverables.mockResolvedValueOnce({
      deliverables: [{ id: 'a', text: '# A', order: 1 }],
      results: {},
      implement: { a: { status: 'passing', tasks: [{ id: 'k1', text: 't1', status: 'done' }], writes: [{ tool: 'create_rule', ok: true }], stale: true } },
    });
    await loadArchitect();
    expect(store.implement.value.a).toMatchObject({ status: 'passing', stale: true });
    expect(store.implement.value.a.tasks).toHaveLength(1);
    expect(store.implement.value.a.writes[0]).toMatchObject({ tool: 'create_rule' });
  });
  it('tolerates a loadDeliverables result with no implement map (older shape)', async () => {
    api.loadDeliverables.mockResolvedValueOnce({ deliverables: [{ id: 'a', text: 'A', order: 1 }], results: {} });
    await loadArchitect();
    expect(store.implement.value).toEqual({});
  });
  it('records loadError without throwing', async () => {
    api.resolveCollection.mockRejectedValueOnce(new Error('nope'));
    await loadArchitect();
    expect(store.loadError.value).toMatch(/nope/);
    expect(store.loaded.value).toBe(false);
  });
  it('selects the first deliverable on first open (no active selection)', async () => {
    api.loadDeliverables.mockResolvedValueOnce({ deliverables: [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }], results: {} });
    store.activeId.value = null;
    await loadArchitect();
    expect(store.activeId.value).toBe('a');
  });
  it('does not override a restored activeId (e.g. after a refresh)', async () => {
    api.loadDeliverables.mockResolvedValueOnce({ deliverables: [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }], results: {} });
    store.activeId.value = 'b';
    await loadArchitect();
    expect(store.activeId.value).toBe('b');
  });
  it('guards against a concurrent double load', async () => {
    api.loadDeliverables.mockResolvedValue({ deliverables: [], results: {} });
    await Promise.all([loadArchitect(), loadArchitect()]);
    expect(api.resolveCollection).toHaveBeenCalledTimes(1);
    expect(api.loadDeliverables).toHaveBeenCalledTimes(1);
  });
});

describe('add/open/update/delete', () => {
  it('addDeliverable seeds the FIRST deliverable with the demo example and opens it', async () => {
    await addDeliverable(); // list is empty (beforeEach)
    expect(store.deliverables.value.length).toBe(1);
    const d = store.deliverables.value[0];
    expect(store.activeId.value).toBe(d.id);
    expect(d.text).toMatch(/Example deliverable/); // the demo callout
    expect(api.addDeliverable).toHaveBeenCalledWith(expect.objectContaining({ id: d.id, text: d.text, order: 1 }));
  });
  it('addDeliverable creates a BLANK deliverable once one already exists', async () => {
    store.deliverables.value = [{ id: 'x', text: '# existing', order: 1 }];
    await addDeliverable();
    const d = store.deliverables.value[store.deliverables.value.length - 1];
    expect(d.text).toBe('');
    expect(d.id).not.toBe('x');
  });
  it('refineTurn: first turn opens a cautious chat and applies the first instruction', async () => {
    scriptReplies({ INSTRUCTION: '# Invoices queue is automated\n\nThe Invoices queue processes documents automatically.' });
    const res = await refineTurn({ chatId: null, deliverableText: 'the invoices Q should be automatic', instruction: 'tighten it' });
    expect(res.chatId).toBeTruthy();
    expect(res.proposal).toMatch(/Invoices queue/);
    const contents = agentApi.streamMessage.mock.calls.map((c) => c[1]);
    expect(contents[0]).toContain('/persona'); // primed cautious first
    expect(contents.some((c) => /REQUIREMENT:/.test(c) && /tighten it/.test(c))).toBe(true); // setup + first instruction
  });
  it('refineTurn: a follow-up reuses the chat and sends just the instruction (no re-setup)', async () => {
    scriptReplies({ INSTRUCTION: '# revised' });
    const res = await refineTurn({ chatId: 'chat_existing', deliverableText: 'base', instruction: 'also name the field' });
    expect(res.chatId).toBe('chat_existing');
    expect(agentApi.createChat).not.toHaveBeenCalled();
    const contents = agentApi.streamMessage.mock.calls.map((c) => c[1]);
    expect(contents.some((c) => /also name the field/.test(c) && !/REQUIREMENT:/.test(c))).toBe(true);
  });
  it('refineTurn: surfaces agent questions (interactive elements) instead of a proposal when the agent asks', async () => {
    let n = 0;
    agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
      onEvent({ type: 'data-agent-question', data: { questions: [{ question: 'Which queue?' }] } });
      onEvent({ type: 'finish' });
    });
    const res = await refineTurn({ chatId: null, deliverableText: 'base', instruction: 'tighten' });
    expect(res.questions).toEqual([{ question: 'Which queue?' }]);
    expect(res.proposal).toBeUndefined();
  });
  it('answerRefine: sends the formatted answers to the SAME chat and returns the revised proposal', async () => {
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      onEvent({ type: 'text-delta', delta: '# revised for the Invoices queue' });
      onEvent({ type: 'finish' });
    });
    const res = await answerRefine({ chatId: 'chat_existing', answers: [{ question: 'Which queue?', answer: 'Invoices' }] });
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(res.chatId).toBe('chat_existing');
    expect(res.proposal).toMatch(/Invoices queue/);
    expect(agentApi.streamMessage.mock.calls[0][1]).toBe('Invoices'); // single answer → bare answer (formatAnswers)
  });
  it('answerRefine: can surface a follow-up question too', async () => {
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      onEvent({ type: 'data-agent-question', data: { questions: [{ question: 'Which field?' }] } });
      onEvent({ type: 'finish' });
    });
    const res = await answerRefine({ chatId: 'c', answers: [{ question: 'Which queue?', answer: 'Invoices' }] });
    expect(res.questions).toEqual([{ question: 'Which field?' }]);
  });
  it('openDeliverable sets activeId', () => { openDeliverable('z'); expect(store.activeId.value).toBe('z'); });
  it('updateDeliverable updates store text live, marks its result stale, and persists editedAt', async () => {
    store.deliverables.value = [{ id: 'a', text: '# old', order: 1 }];
    store.setResult('a', { verdict: 'pass', evidence: 'e', chatId: 'c', ranAt: 5, stale: false });
    await updateDeliverable('a', '# new body');
    expect(store.deliverables.value[0].text).toBe('# new body');
    expect(store.results.value.a.stale).toBe(true);
    expect(api.updateDeliverable).toHaveBeenCalledWith('a', '# new body', expect.any(Number));
    await flush(); // let the fire-and-forget generateTitle() side effect settle before the next test
  });
  it('updateDeliverable no-ops when unchanged', async () => {
    store.deliverables.value = [{ id: 'a', text: 'same', order: 1 }];
    await updateDeliverable('a', 'same');
    expect(api.updateDeliverable).not.toHaveBeenCalled();
  });
  it('deleteDeliverable removes it, its result, and clears activeId if open', async () => {
    store.deliverables.value = [{ id: 'a', text: 'x', order: 1 }];
    store.setResult('a', { verdict: 'pass', evidence: '', chatId: 'c', ranAt: 1, stale: true });
    store.activeId.value = 'a';
    await deleteDeliverable('a');
    expect(store.deliverables.value).toEqual([]);
    expect(store.results.value.a).toBeUndefined();
    expect(store.activeId.value).toBeNull();
  });
});

describe('reorder / moveDeliverable', () => {
  it('reorder is a pure move (from → to)', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
  it('moveDeliverable reorders the store, reassigns sequential orders, and persists changed docs', async () => {
    store.deliverables.value = [
      { id: 'a', text: 'A', order: 0 },
      { id: 'b', text: 'B', order: 1 },
      { id: 'c', text: 'C', order: 2 },
    ];
    await moveDeliverable('a', 2); // A to the end → [B, C, A]
    expect(store.deliverables.value.map((d) => d.id)).toEqual(['b', 'c', 'a']);
    expect(store.deliverables.value.map((d) => d.order)).toEqual([0, 1, 2]);
    // all three changed order → three setOrder calls
    expect(api.setOrder).toHaveBeenCalledWith('b', 0);
    expect(api.setOrder).toHaveBeenCalledWith('c', 1);
    expect(api.setOrder).toHaveBeenCalledWith('a', 2);
  });
  it('moveDeliverable no-ops for an unknown id or the same position', async () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 0 }, { id: 'b', text: 'B', order: 1 }];
    await moveDeliverable('zzz', 1);
    await moveDeliverable('a', 0);
    expect(api.setOrder).not.toHaveBeenCalled();
    expect(store.deliverables.value.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('runAll', () => {
  it('checks each deliverable in its own chat, records verdicts, and persists results (stale cleared)', async () => {
    store.deliverables.value = [{ id: 'a', text: 'ALPHA', order: 1 }, { id: 'b', text: 'BETA', order: 2 }];
    scriptReplies({ ALPHA: 'VERDICT: PASS\ngood', BETA: 'VERDICT: FAIL\n- bad' });
    await runAll();
    expect(store.results.value.a.verdict).toBe('pass');
    expect(store.results.value.a.stale).toBe(false);
    expect(store.results.value.b.verdict).toBe('fail');
    expect(api.saveResult).toHaveBeenCalledTimes(2);
    expect(api.saveResult).toHaveBeenCalledWith('a', expect.objectContaining({ verdict: 'pass', chatId: 'chat_0' }));
    expect(store.running.value).toBe(false);
  });
  it('never sends a write-enabling flag (read-only contract)', async () => {
    store.deliverables.value = [{ id: 'a', text: 'ALPHA', order: 1 }];
    scriptReplies({ ALPHA: 'VERDICT: PASS' });
    await runAll();
    for (const call of agentApi.createChat.mock.calls) expect(call.length).toBe(0);
    for (const call of agentApi.streamMessage.mock.calls) {
      const opts = call[2] || {};
      expect('mcp_mode' in opts).toBe(false);
      expect(Object.keys(opts).sort()).toEqual(['onEvent', 'signal']);
    }
  });
  it('no-ops on an empty list', async () => { await runAll(); expect(agentApi.createChat).not.toHaveBeenCalled(); });
  it('does not persist a transient-error result (keeps last-known-good), but persists good ones', async () => {
    store.deliverables.value = [{ id: 'a', text: 'ALPHA', order: 1 }, { id: 'b', text: 'BETA', order: 2 }];
    let n = 0;
    agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
      if (content.includes('ALPHA')) throw Object.assign(new Error('rate limited'), { status: 429 });
      onEvent({ type: 'text-delta', delta: 'VERDICT: PASS' }); onEvent({ type: 'finish' });
    });
    await runAll();
    expect(store.results.value.a.verdict).toBe('uncertain');
    expect(store.results.value.a.error).toBe(true);
    expect(api.saveResult).toHaveBeenCalledWith('b', expect.objectContaining({ verdict: 'pass' }));
    expect(api.saveResult).not.toHaveBeenCalledWith('a', expect.anything());
  });
});

describe('renameDeliverable / generateTitle / backfillTitles', () => {
  it('renameDeliverable sets the store title (trimmed) and persists it as a MANUAL rename', async () => {
    store.deliverables.value = [{ id: 'a', text: 'Add a VAT rule', order: 1 }];
    await renameDeliverable('a', '  Add VAT Rule  ');
    expect(store.deliverables.value[0]).toMatchObject({ title: 'Add VAT Rule', titleSource: 'manual' });
    expect(api.saveTitle).toHaveBeenCalledWith('a', 'Add VAT Rule', 'manual');
  });

  it('generateTitle opens a READ-ONLY chat and sets the parsed title on an untitled deliverable', async () => {
    store.deliverables.value = [{ id: 'a', text: 'Add a VAT rule to the Invoices queue', order: 1 }];
    let n = 0;
    agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
      onEvent({ type: 'text-delta', delta: '"Add VAT Rule"' });
      onEvent({ type: 'finish' });
    });
    await generateTitle('a');
    expect(store.deliverables.value[0].title).toBe('Add VAT Rule');
    // marked 'ai', NOT 'manual' — a generated title must stay beatable by a heading
    expect(api.saveTitle).toHaveBeenCalledWith('a', 'Add VAT Rule', 'ai');
    // read-only contract: no write-enabling flag on the chat or the message
    expect(agentApi.createChat).toHaveBeenCalledWith();
    const opts = agentApi.streamMessage.mock.calls[0][2];
    expect(opts.mcpMode).toBeUndefined();
    expect('mcp_mode' in opts).toBe(false);
  });

  it('generateTitle is a no-op when the deliverable already has a title', async () => {
    store.deliverables.value = [{ id: 'a', text: 'Add a VAT rule to the Invoices queue', order: 1, title: 'Existing' }];
    await generateTitle('a');
    expect(agentApi.createChat).not.toHaveBeenCalled();
  });

  it('generateTitle is a no-op when the deliverable text is too short', async () => {
    store.deliverables.value = [{ id: 'a', text: 'short', order: 1 }];
    await generateTitle('a');
    expect(agentApi.createChat).not.toHaveBeenCalled();
  });

  it('generateTitle is a no-op when the text declares its own heading', async () => {
    // The heading already wins in displayTitle, so the agent call is pure waste.
    store.deliverables.value = [{ id: 'a', text: '# Invoices Queue Automation\nmust be touchless', order: 1 }];
    await generateTitle('a');
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(api.saveTitle).not.toHaveBeenCalled();
  });

  it('generateTitle still runs when the heading is not on the first non-empty line', async () => {
    store.deliverables.value = [{ id: 'a', text: '> banner line\n\n# Not the first line', order: 1 }];
    agentApi.createChat.mockResolvedValue('chat_x');
    agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
      onEvent({ type: 'text-delta', delta: 'Generated Title' });
      onEvent({ type: 'finish' });
    });
    await generateTitle('a');
    expect(store.deliverables.value[0].title).toBe('Generated Title');
  });

  it('backfillTitles generates titles only for untitled, headingless deliverables with enough text', async () => {
    store.deliverables.value = [
      { id: 'a', text: 'Add a VAT rule to the Invoices queue', order: 1 },
      { id: 'b', text: 'Add a currency rule to the Invoices queue', order: 2, title: 'Already Titled' },
      { id: 'c', text: 'short', order: 3 },
      { id: 'd', text: '# Vendor Matching\nmatch every vendor against the master data', order: 4 },
    ];
    agentApi.createChat.mockResolvedValue('chat_x');
    agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
      onEvent({ type: 'text-delta', delta: 'Generated Title' });
      onEvent({ type: 'finish' });
    });
    await backfillTitles();
    expect(store.deliverables.value.find((d) => d.id === 'a').title).toBe('Generated Title');
    expect(store.deliverables.value.find((d) => d.id === 'b').title).toBe('Already Titled'); // untouched
    expect(store.deliverables.value.find((d) => d.id === 'c').title).toBeUndefined(); // too short, untouched
    expect(store.deliverables.value.find((d) => d.id === 'd').title).toBeUndefined(); // declares its own heading, untouched
    expect(agentApi.createChat).toHaveBeenCalledTimes(1); // only 'a' qualified
  });
});
