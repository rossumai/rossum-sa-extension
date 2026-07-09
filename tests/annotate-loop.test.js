import { runAnnotate } from '../src/rossum/annotate/loop.js';
import { describe, it, expect, vi } from 'vitest';

function memStore() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } }; }

it('proposes → applies → validates → refines once → clean, and is undoable', async () => {
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'old', position: [10,10,30,20], page: 1, rir_confidence: 0.4 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10,10,50,20], text: 'INV-1' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  let turn = 0;
  const streamFabry = vi.fn(async ({ onEvent }) => {
    turn += 1;
    const json = turn === 1
      ? '{"headers":[{"schema_id":"d","value":"INV-1","printed":"INV-1","page":1}],"tables":[]}'
      : '[{"datapoint_id":1,"new_value":"INV-2","reason":"still bad","confidence":0.9}]';
    onEvent({ type: 'text-delta', delta: '```json\n' + json + '\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  // validate: first call after initial apply → 1 error on dp1; after the refine apply → clean.
  let validated = 0;
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) {
      const op = body.operations[0];
      contentTree[0].content.value = op.value.content.value; // reflect write
      return Promise.resolve({ content: contentTree });
    }
    if (p.endsWith('/content/validate')) { validated += 1; return Promise.resolve({ messages: validated === 1 ? [{ type: 'error', content: 'not in master data', id: 1, schema_id: 'd' }] : [] }); }
    throw new Error('x ' + p);
  });
  const store = memStore();
  const progress = [];
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store }, onProgress: (ph) => progress.push(ph) });
  expect(out.undoable).toBe(true);
  expect(out.applied.length).toBeGreaterThanOrEqual(1);
  expect(out.remaining).toEqual([]);
  // ONE reading turn (pass 1) + one refine turn. Pass 2 reuses the CACHED reading
  // and must NOT write the page's INV-1 back over the refine's INV-2 (refined
  // values outrank the raw reading) — so no third Fabry call ever happens.
  expect(streamFabry).toHaveBeenCalledTimes(2);
  expect(contentTree[0].content.value).toBe('INV-2'); // the refine result SURVIVES pass 2
  expect(post.mock.calls.filter((c) => c[0].endsWith('/cancel')).length).toBeGreaterThanOrEqual(1); // every start released
  expect(progress).toContain('apply');
  expect(progress).toContain('validate');
  // snapshot persisted for undo
  const { loadSnapshot } = await import('../src/rossum/annotate/undo.js');
  expect(loadSnapshot(5, store)).toMatchObject({ 1: { value: 'old' } });
});

it('cancels exactly once even when refine-apply fails, proving finally-locked safety', async () => {
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'old', position: [10,10,30,20], page: 1, rir_confidence: 0.4 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10,10,50,20], text: 'INV-1' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  let turn = 0;
  const streamFabry = vi.fn(async ({ onEvent }) => {
    turn += 1;
    const json = turn === 1
      ? '{"headers":[{"schema_id":"d","value":"INV-1","printed":"INV-1","page":1}],"tables":[]}'
      : '[{"datapoint_id":1,"new_value":"INV-2","reason":"still bad","confidence":0.9}]';
    onEvent({ type: 'text-delta', delta: '```json\n' + json + '\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  let validated = 0;
  let contentOpsCount = 0;
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) {
      contentOpsCount += 1;
      if (contentOpsCount === 2) return Promise.reject(new Error('mid-loop ops failure'));
      const op = body.operations[0];
      contentTree[0].content.value = op.value.content.value;
      return Promise.resolve({ content: contentTree });
    }
    if (p.endsWith('/content/validate')) { validated += 1; return Promise.resolve({ messages: validated === 1 ? [{ type: 'error', content: 'not in master data', id: 1, schema_id: 'd' }] : [] }); }
    throw new Error('x ' + p);
  });
  const store = memStore();
  const promise = runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store } });
  await expect(promise).rejects.toThrow('mid-loop ops failure');
  expect(post.mock.calls.filter((c) => c[0].endsWith('/cancel'))).toHaveLength(1); // finally fired exactly once despite throw
});

it('tightens a loose box deterministically even when Fabry proposes nothing', async () => {
  // A loose box [100,100,300,200] hugging a single word "val" at [110,110,150,130].
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'keep', position: [100, 100, 300, 200], page: 1, rir_confidence: 0.9 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [110, 110, 150, 130], text: 'val' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 400, height: 400 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => { onEvent({ type: 'text-delta', delta: '```json\n[]\n```' }); onEvent({ type: '__done__' }); return { chatId: 'c1' }; });
  const ops = [];
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) { ops.push(body.operations); return Promise.resolve({ content: contentTree }); }
    if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
    throw new Error('x ' + p);
  });
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store: memStore() } });
  expect(out.applied).toHaveLength(1);
  expect(out.applied[0]).toMatchObject({ datapointId: 1, boxSource: 'tighten', valueChanged: false, boxChanged: true, newBox: [109, 109, 151, 131] });
  // the written op tightened the box and did NOT clobber the value
  expect(ops[0][0].value.content).toEqual({ value: 'keep', position: [109, 109, 151, 131], page: 1 });
});

it('preserves a prior snapshot value across a retry (merge-preserve, never clobbered by freshly-gathered content)', async () => {
  // Simulates a retry after an earlier partial run: gather now sees "old" (a write
  // that already landed), but the TRUE original — "ORIGINAL" — is still on disk from
  // that earlier attempt's snapshot. The initial-snapshot save must keep it.
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'old', position: [10,10,30,20], page: 1, rir_confidence: 0.4 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10,10,50,20], text: 'INV-1' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => {
    onEvent({ type: 'text-delta', delta: '```json\n{"headers":[{"schema_id":"d","value":"INV-1","printed":"INV-1","page":1}],"tables":[]}\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) {
      const op = body.operations[0];
      contentTree[0].content.value = op.value.content.value;
      return Promise.resolve({ content: contentTree });
    }
    if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] }); // clean immediately, no refine
    throw new Error('x ' + p);
  });
  const store = memStore();
  const { saveSnapshot, loadSnapshot } = await import('../src/rossum/annotate/undo.js');
  saveSnapshot(5, { 1: { value: 'ORIGINAL', position: [1, 1, 2, 2], page: 1 } }, store);

  await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store } });

  expect(loadSnapshot(5, store)[1].value).toBe('ORIGINAL'); // prior (older, truer) wins over gathered 'old'
});

it('adds a missing table row read off the page, records it for undo, and reports it', async () => {
  // A doc with an EMPTY tax_details table (0 rows). Fabry's READING shows one printed row.
  const taxMv = { category: 'multivalue', id: 500, schema_id: 'tax_details', children: [] };
  const contentTree = [{ category: 'section', children: [
    { category: 'datapoint', id: 1, schema_id: 'total', content: { value: 'ok', position: [10, 10, 30, 20], page: 1, rir_confidence: 0.9 } },
    taxMv,
  ] }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10, 10, 30, 20], text: 'ok' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'total', label: 'T', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => {
    onEvent({ type: 'text-delta', delta: '```json\n{"headers":[],"tables":[{"table":"tax_details","rows":[{"cells":[{"schema_id":"tax_detail_base","value":"100","printed":"100"}]}]}]}\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) {
      if (body.operations[0].op === 'add') taxMv.children.push({ category: 'tuple', id: 5001, children: [] }); // server assigns row id
      return Promise.resolve({ content: contentTree });
    }
    if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
    throw new Error('x ' + p);
  });
  const store = memStore();
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store } });
  expect(out.addedRows).toBe(1);
  expect(out.undoable).toBe(true);
  // the add op targeted the multivalue content id with value-only cells
  const addCall = post.mock.calls.find((c) => c[0].endsWith('/content/operations') && c[1].operations[0].op === 'add');
  expect(addCall[1].operations).toEqual([{ op: 'add', id: 500, value: [{ schema_id: 'tax_detail_base', content: { value: '100' } }] }]);
  // the newly-created row id was recorded for Undo
  const { loadSnapshot } = await import('../src/rossum/annotate/undo.js');
  expect(loadSnapshot(5, store).__addedRows).toEqual([5001]);
});

it('applies geometry tightening and returns a note (no throw) when the Fabry turn fails', async () => {
  // Loose box → geometry phase applies; Fabry then dies → run still succeeds with a note.
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'keep', position: [100, 100, 300, 200], page: 1, rir_confidence: 0.9 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [110, 110, 150, 130], text: 'val' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 400, height: 400 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(() => Promise.reject(new Error('Agent timed out')));
  const post = vi.fn((p) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) return Promise.resolve({ content: contentTree });
    throw new Error('x ' + p);
  });
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store: memStore() } });
  expect(out.applied).toHaveLength(1); // the tighten landed
  expect(out.applied[0]).toMatchObject({ boxSource: 'tighten' });
  expect(out.note).toMatch(/AI analysis failed/);
  expect(out.undoable).toBe(true);
  expect(post.mock.calls.filter((c) => c[0].endsWith('/cancel'))).toHaveLength(1); // geometry session released
});

it('rethrows a Fabry failure when nothing was applied (no silent no-op)', async () => {
  // Tight box → geometry proposes nothing; Fabry dies → the failure must surface.
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'keep', position: [109, 109, 151, 131], page: 1, rir_confidence: 0.9 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [110, 110, 150, 130], text: 'val' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 400, height: 400 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(() => Promise.reject(new Error('Agent timed out')));
  const post = vi.fn((p) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    throw new Error('x ' + p);
  });
  await expect(runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store: memStore() } }))
    .rejects.toThrow(/timed out/i);
  expect(post.mock.calls.filter((c) => c[0].endsWith('/content/operations'))).toHaveLength(0); // nothing written
});

it('de-stacks identical quantity boxes and clears the orphaned empty-field box in one deterministic pass', async () => {
  // Mirror of the real doc: qty boxes stacked at row 1; "code" is EMPTY-valued but boxed
  // over row 1's token; desc siblings define row bands; a qty token exists per row.
  const contentTree = [{ category: 'section', children: [
    { category: 'multivalue', id: 900, schema_id: 'li', children: [
      { category: 'tuple', id: 901, children: [
        { category: 'datapoint', id: 1, schema_id: 'qty', content: { value: '7', position: [10, 10, 30, 20], page: 1 } },
        { category: 'datapoint', id: 21, schema_id: 'code', content: { value: '', position: [9, 9, 31, 21], page: 1 } },
        { category: 'datapoint', id: 11, schema_id: 'desc', content: { value: 'a', position: [50, 10, 90, 20], page: 1 } },
      ] },
      { category: 'tuple', id: 902, children: [
        { category: 'datapoint', id: 2, schema_id: 'qty', content: { value: '7', position: [10, 10, 30, 20], page: 1 } },
        { category: 'datapoint', id: 12, schema_id: 'desc', content: { value: 'b', position: [50, 30, 90, 40], page: 1 } },
      ] },
    ] },
  ] }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [
      { position: [12, 11, 28, 19], text: '7' }, { position: [12, 31, 28, 39], text: '7' },
      { position: [52, 11, 88, 19], text: 'a' }, { position: [52, 31, 88, 39], text: 'b' },
    ] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 200, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => { onEvent({ type: 'text-delta', delta: '```json\n[]\n```' }); onEvent({ type: '__done__' }); return { chatId: 'c1' }; });
  const opsBatches = [];
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) { opsBatches.push(body.operations); return Promise.resolve({ content: contentTree }); }
    if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
    throw new Error('x ' + p);
  });
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store: memStore() } });
  const ops = opsBatches.flat();
  const clear = ops.find((o) => o.id === 21);
  expect(clear.value.content.position).toBeNull(); // orphaned code box cleared
  const destack = ops.find((o) => o.id === 2);
  expect(destack.value.content.position).toEqual([11, 30, 29, 40]); // qty row 2 → its own band
  expect(ops.find((o) => o.id === 1)).toBeUndefined(); // row 1 keeps its box
  // no two written boxes overlap
  const boxes = ops.filter((o) => o.value.content.position).map((o) => o.value.content.position);
  const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(inter(boxes[i], boxes[j])).toBeLessThanOrEqual(0.5);
  expect(out.applied.length).toBeGreaterThanOrEqual(2);
});

it('resolves reseed conflicts: tightens a grazing loose neighbor and clears a squatting wrong box', async () => {
  // Row 1's "rate" box is 1px too tall (grazes row 2's line); "totaltax" has a bogus
  // tall box sitting over the other rows' values. Reseeds for rows 2 must land.
  const contentTree = [{ category: 'section', children: [
    { category: 'datapoint', id: 50, schema_id: 'totaltax', content: { value: '99', position: [30, 10, 46, 60], page: 1 } },
    { category: 'multivalue', id: 800, schema_id: 'tax', children: [
      { category: 'tuple', id: 801, children: [
        { category: 'datapoint', id: 61, schema_id: 'rate', content: { value: '0%', position: [10, 10, 26, 31], page: 1 } }, // loose: bottom bleeds to 31
        { category: 'datapoint', id: 71, schema_id: 'tx', content: { value: '10', position: [30, 10, 46, 20], page: 1 } },
      ] },
      { category: 'tuple', id: 802, children: [
        { category: 'datapoint', id: 62, schema_id: 'rate', content: { value: '10%', position: null, page: null } },
        { category: 'datapoint', id: 72, schema_id: 'tx', content: { value: '20', position: null, page: null } },
      ] },
    ] },
  ] }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [
      { position: [10, 12, 26, 19], text: '0%' }, { position: [30, 12, 46, 19], text: '10' },
      { position: [10, 30, 26, 39], text: '10%' }, { position: [30, 30, 46, 39], text: '20' },
    ] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => { onEvent({ type: 'text-delta', delta: '```json\n[]\n```' }); onEvent({ type: '__done__' }); return { chatId: 'c1' }; });
  const opsBatches = [];
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) { opsBatches.push(body.operations); return Promise.resolve({ content: contentTree }); }
    if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
    throw new Error('x ' + p);
  });
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store: memStore() } });
  const ops = opsBatches.flat();
  const byId = Object.fromEntries(ops.map((o) => [o.id, o]));
  expect(byId[62].value.content.position).toEqual([9, 29, 27, 40]);  // rate r2 reseeded
  expect(byId[61].value.content.position).toEqual([9, 11, 27, 20]);  // rate r1 tightened to make room
  expect(byId[50].value.content.position).toBeNull();                 // squatting totaltax box cleared
  expect(byId[50].value.content.value).toBe('99');                    // its value kept
  expect(byId[72].value.content.position).toEqual([29, 29, 47, 40]); // tx r2 reseeded after squatter cleared
  // no written boxes overlap
  const boxes = ops.filter((o) => o.value.content.position).map((o) => o.value.content.position);
  const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(inter(boxes[i], boxes[j])).toBeLessThanOrEqual(0.5);
  expect(out.applied.length).toBeGreaterThanOrEqual(4);
});

it('outer improvement loop: pass 2 fixes what pass 1 enabled, Fabry is skipped once quiet, plateau stops', async () => {
  // Row 1 col-a boxed. Row 2: col-a recoverable via the column strip (pass 1);
  // col-b needs the ROW BAND that only exists after col-a r2 is boxed (pass 2).
  const contentTree = [{ category: 'section', children: [
    { category: 'multivalue', id: 900, schema_id: 'li', children: [
      { category: 'tuple', id: 901, children: [
        { category: 'datapoint', id: 11, schema_id: 'a', content: { value: 'p', position: [10, 10, 26, 20], page: 1 } },
      ] },
      { category: 'tuple', id: 902, children: [
        { category: 'datapoint', id: 21, schema_id: 'a', content: { value: 'q', position: null, page: null } },
        { category: 'datapoint', id: 22, schema_id: 'b', content: { value: 'k9', position: null, page: null } },
      ] },
    ] },
  ] }];
  let gathers = 0;
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) { gathers++; return Promise.resolve({ content: JSON.parse(JSON.stringify(contentTree)) }); }
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [
      { position: [10, 12, 26, 19], text: 'p' }, { position: [10, 30, 26, 39], text: 'q' }, { position: [40, 30, 56, 39], text: 'k9' },
    ] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => { onEvent({ type: 'text-delta', delta: '```json\n[]\n```' }); onEvent({ type: '__done__' }); return { chatId: 'c1' }; });
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) {
      // apply the writes so the next pass's gather sees them
      const byId = { 11: null, 21: null, 22: null };
      const walk = (nodes) => { for (const n of nodes) { if (n.category === 'datapoint' && n.id in byId) byId[n.id] = n; else if (Array.isArray(n.children)) walk(n.children); } };
      walk(contentTree);
      for (const op of body.operations) {
        const dp = byId[op.id];
        if (dp) { dp.content.value = op.value.content.value; dp.content.position = op.value.content.position ?? dp.content.position; if (op.value.content.page != null) dp.content.page = op.value.content.page; }
      }
      return Promise.resolve({ content: JSON.parse(JSON.stringify(contentTree)) });
    }
    if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
    throw new Error('x ' + p);
  });
  const progress = [];
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store: memStore() }, onProgress: (ph, d) => progress.push(`${ph}:${d || ''}`) });
  const appliedIds = out.applied.map((c) => c.datapointId);
  expect(appliedIds).toContain(21); // pass 1: strip recovery
  expect(appliedIds).toContain(22); // pass 2: band recovery enabled by pass 1
  expect(gathers).toBeGreaterThanOrEqual(2);            // looped
  expect(streamFabry).toHaveBeenCalledTimes(1);          // Fabry skipped once quiet
  expect(progress.some((x) => x.startsWith('pass:'))).toBe(true); // plateau ticks reported
});
