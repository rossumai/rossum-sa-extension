// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import ImportConfirm from '../src/mdh/components/ImportConfirm.jsx';
import { deriveShape } from '../src/mdh/shape.js';

function mount(vnode: any) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  render(vnode, el);
  return el;
}
async function waitFor(fn: any, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function openPlan(root: any) {
  (await waitFor(() => root.querySelector('[data-testid="import-summary-toggle"]'))).click();
  return waitFor(() => root.querySelector('[data-testid="import-plan"]'));
}
const docs = [
  { sku: 'A1', price: 10 },
  { sku: 'B2', price: 20 },
];
const base = {
  docs,
  mode: 'insert',
  setMode() {},
  keys: [],
  setKeys() {},
  shapeOverride: false,
  setShapeOverride() {},
  shapeError: false,
  shape: null,
  shapeLoading: false,
  onImport() {},
  onCancel() {},
};

describe('ImportConfirm', () => {
  it('insert step list explains verified insert behavior and enables Go', async () => {
    const root = mount(<ImportConfirm {...base} mode="insert" />);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      false,
    );
    await openPlan(root);
    const t = root.querySelector('[data-testid="import-plan"]')!.textContent;
    expect(t).toMatch(/added as a new record/i);
    expect(t).toMatch(/never modified/i);
    expect(t).toMatch(/already exists in the collection is rejected/i);
    expect(t).toMatch(/cancelling keeps the rows already inserted/i);
  });

  it('update requires match keys (Go disabled until a key is chosen)', async () => {
    const noKeys = mount(<ImportConfirm {...base} mode="update" keys={[]} />);
    expect(noKeys.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      true,
    );
    const withKeys = mount(<ImportConfirm {...base} mode="update" keys={['sku']} />);
    expect(withKeys.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      false,
    );
    await openPlan(withKeys);
    expect(withKeys.querySelector('[data-testid="import-plan"]')!.textContent).toMatch(
      /matched to existing records by sku/i,
    );
  });

  it('update step list explains verified upsert behavior including the _id gotcha', async () => {
    const root = mount(<ImportConfirm {...base} mode="update" keys={['sku']} />);
    await openPlan(root);
    const t = root.querySelector('[data-testid="import-plan"]')!.textContent;
    expect(t).toMatch(/matched to existing records by sku/i);
    expect(t).toMatch(/replaced by the row entirely/i);
    expect(t).toMatch(/only one of them is updated/i);
    expect(t).toMatch(/match nothing are inserted/i);
    expect(t).toMatch(/_id.*ignored/i);
    expect(t).toMatch(/can.t be recalled or undone/i); // apostrophe is curly (U+2019) in the copy
  });

  it('multi-key update copy states AND semantics; single-key copy does not', async () => {
    const multi = mount(
      <ImportConfirm
        {...base}
        docs={[{ sku: 'A', region: 'EU' }]}
        mode="update"
        keys={['sku', 'region']}
      />,
    );
    await openPlan(multi);
    const t = multi.querySelector('[data-testid="import-plan"]')!.textContent;
    expect(t).toMatch(/matched to existing records by sku, region/i);
    expect(t).toMatch(/all of them must match at once \(AND, not OR\)/i);
    expect(t).toMatch(/equal in only some of these fields is not a match/i);
    const single = mount(
      <ImportConfirm {...base} docs={[{ sku: 'A' }]} mode="update" keys={['sku']} />,
    );
    await openPlan(single);
    expect(single.querySelector('[data-testid="import-plan"]')!.textContent).not.toMatch(
      /AND, not OR/,
    );
  });

  it('update step list prompts for keys when none chosen', async () => {
    const root = mount(<ImportConfirm {...base} mode="update" keys={[]} />);
    await openPlan(root);
    expect(root.querySelector('[data-testid="import-plan"]')!.textContent).toMatch(
      /Choose one or more fields/i,
    );
    expect(root.querySelector('[data-testid="import-summary"]')!.textContent).toMatch(
      /Pick one or more fields above/i,
    );
  });

  it('replace step list explains wipe-and-load including the _id gotcha', async () => {
    const root = mount(<ImportConfirm {...base} mode="replace" />);
    await openPlan(root);
    const t = root.querySelector('[data-testid="import-plan"]')!.textContent;
    expect(t).toMatch(/Deletes every existing record/i);
    expect(t).toMatch(/Custom indexes are kept/i);
    expect(t).toMatch(/ids from an export are not preserved/i);
  });

  it('blocks Update with the exact missing-key row count', () => {
    const mixed = [{ sku: 'A' }, { name: 'no-key' }, { name: 'also-none' }];
    const root = mount(<ImportConfirm {...base} docs={mixed} mode="update" keys={['sku']} />);
    const guard = root.querySelector('[data-testid="import-key-guard"]')!;
    expect(guard.textContent).toMatch(/2 rows are missing/);
    expect(guard.textContent).toMatch(/sku/);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(true);
  });

  it('summary sentence: insert states count and never-modified', () => {
    const root = mount(<ImportConfirm {...base} mode="insert" />);
    expect(root.querySelector('[data-testid="import-summary"]')!.textContent).toBe(
      'Adds 2 new records — existing records are never modified.',
    );
  });

  it('summary sentence: insert mentions dropped duplicate _id rows only when true', () => {
    const dup = [
      { _id: 1, a: 1 },
      { _id: 1, a: 2 },
      { _id: 2, a: 3 },
    ];
    const root = mount(<ImportConfirm {...base} docs={dup} mode="insert" />);
    expect(root.querySelector('[data-testid="import-summary"]')!.textContent).toBe(
      'Adds 2 new records — existing records are never modified. (1 duplicate _id row dropped.)',
    );
    const clean = mount(<ImportConfirm {...base} mode="insert" />);
    expect(clean.querySelector('[data-testid="import-summary"]')!.textContent).not.toContain(
      'duplicate',
    );
  });

  it('summary sentence: update states keys, whole-row replace, server, no undo', () => {
    const root = mount(<ImportConfirm {...base} mode="update" keys={['sku']} />);
    expect(root.querySelector('[data-testid="import-summary"]')!.textContent).toBe(
      'Upserts 2 rows matched by sku — matched records are replaced whole, unmatched rows are inserted. Runs on the server; can’t be undone.',
    );
  });

  it('summary sentence: multi-key update appends (all must match)', () => {
    const root = mount(
      <ImportConfirm
        {...base}
        docs={[{ sku: 'A', region: 'EU' }]}
        mode="update"
        keys={['sku', 'region']}
      />,
    );
    expect(root.querySelector('[data-testid="import-summary"]')!.textContent).toContain(
      'matched by sku + region (all must match)',
    );
  });

  it('summary sentence: replace states wipe-and-load and no undo', () => {
    const root = mount(<ImportConfirm {...base} mode="replace" />);
    expect(root.querySelector('[data-testid="import-summary"]')!.textContent).toBe(
      'Deletes every existing record, then loads these 2 rows as the collection’s new contents. Can’t be undone.',
    );
  });

  it('renders a Back button only when onBack is provided, and calls it', () => {
    const onBack = vi.fn();
    const withBack = mount(<ImportConfirm {...base} onBack={onBack} />);
    const btn = withBack.querySelector<HTMLElement>('[data-testid="import-back"]');
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    const without = mount(<ImportConfirm {...base} />);
    expect(without.querySelector('[data-testid="import-back"]')).toBe(null);
  });

  it('shows a muted one-line pass state with the sample size', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={137} docs={[{ sku: 'B2', price: 20 }]} />,
    );
    const ok = root.querySelector('[data-testid="import-shape-ok"]')!;
    expect(ok.textContent).toMatch(/Shape matches/);
    expect(ok.textContent).toMatch(/checked against a 137-record random sample/i);
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
  });

  it('says "all N existing records" when the sample covered the whole collection', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(
      <ImportConfirm
        {...base}
        shape={shape}
        shapeCount={150}
        shapeCoversAll
        docs={[{ sku: 'B2', price: 20 }]}
      />,
    );
    expect(root.querySelector('[data-testid="import-shape-ok"]')!.textContent).toMatch(
      /checked against all 150 existing records/i,
    );
  });

  it('empty collection: no shape UI on screen, a skip note inside Details', async () => {
    const root = mount(<ImportConfirm {...base} shape={null} />);
    expect(root.querySelector('[data-testid="import-shape-ok"]')).toBe(null);
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
    await openPlan(root);
    expect(root.querySelector('[data-testid="import-plan"]')!.textContent).toMatch(
      /shape check skipped/i,
    );
  });

  it('shape fetch failure: unavailable note inside Details', async () => {
    const root = mount(<ImportConfirm {...base} shape={null} shapeError />);
    await openPlan(root);
    expect(root.querySelector('[data-testid="import-plan"]')!.textContent).toMatch(
      /Shape check unavailable/i,
    );
  });

  // Reviewer-measured defect: shapeCheck is null while shape is still null
  // (i.e. still loading), so shapeOk was true and canImport was true for the
  // whole $sample round trip — restoreDocs had already run with shape===null
  // (heuristics only), so a fast click could import documents the
  // shape-guided restore layer never touched.
  it('disables Go while the shape sample is still loading, for every mode', () => {
    const insert = mount(<ImportConfirm {...base} mode="insert" shapeLoading />);
    expect(insert.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      true,
    );

    const update = mount(<ImportConfirm {...base} mode="update" keys={['sku']} shapeLoading />);
    expect(update.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      true,
    );

    const replace = mount(<ImportConfirm {...base} mode="replace" shapeLoading />);
    expect(replace.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      true,
    );
  });

  it('shows the sample note inside the red panel on mismatch', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]);
    const bad = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={42} docs={[{ sku: 'B2', price: 20 }]} />,
    );
    expect(bad.querySelector('[data-testid="import-shape-error"]')!.textContent).toMatch(
      /a random sample of 42 existing records/i,
    );
  });

  it('blocks Go with an error-styled panel when docs do not match the shape', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]); // requires region
    const root = mount(<ImportConfirm {...base} mode="insert" shape={shape} />);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(true);
    const err = root.querySelector('[data-testid="import-shape-error"]')!;
    expect(err).toBeTruthy();
    expect(err.classList.contains('import-error')).toBe(true); // danger-styled, not the info box
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toMatch(/blocked/i);
    expect(err.textContent).toMatch(/region/); // the missing field is named
  });

  it('a row missing an optional field no longer trips the guard', () => {
    const shape = deriveShape([
      { sku: 'A1', price: 10 },
      { sku: 'B2', price: 20, note: 'x' },
    ]);
    const root = mount(<ImportConfirm {...base} mode="insert" shape={shape} shapeCount={2} />);
    expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
    expect(root.querySelector('[data-testid="import-shape-ok"]')).toBeTruthy();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      false,
    );
  });

  it('no longer shows the over-rejection note, because it no longer over-rejects', () => {
    const shape = deriveShape([
      { sku: 'A1', price: 10 },
      { sku: 'B2', price: 20, note: 'x' },
    ]);
    const root = mount(<ImportConfirm {...base} mode="insert" shape={shape} />);
    expect(root.textContent).not.toMatch(/over-reject/i);
  });

  it('reports a whitespace-only column difference explicitly and visibly', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={1} docs={[{ 'sku ': 'B2', price: 20 }]} />,
    );
    const err = root.querySelector('[data-testid="import-shape-error"]')!;
    expect(err.textContent).toMatch(/only by leading\/trailing whitespace/i);
    expect(err.textContent).toMatch(/"sku·"/); // file side, marked
    expect(err.textContent).toMatch(/"sku"/); // existing side
    expect(err.querySelector('.mdh-special-space')).toBeTruthy();
    expect(root.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(true);
  });

  it('renders Missing/Unexpected names through the whitespace-revealing renderer', () => {
    const shape = deriveShape([{ 'region ': 'EU' }]); // NBSP (U+00A0) lives in the DB field name
    const root = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={1} docs={[{ zone: 'EU' }]} />,
    );
    const err = root.querySelector('[data-testid="import-shape-error"]');
    expect(err!.textContent).toContain('NBSP'); // DB-side NBSP made visible in the Missing list
  });

  it('the acknowledgement checkbox overrides the mismatch and keeps the error visible', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]);
    let override = false;
    const setShapeOverride = (v: any) => {
      override = v;
    };
    const root = mount(
      <ImportConfirm {...base} mode="insert" shape={shape} setShapeOverride={setShapeOverride} />,
    );
    const box = root.querySelector<HTMLInputElement>('[data-testid="shape-override"]')!;
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(true);
    box.click(); // ticking the box acknowledges the mismatch
    expect(override).toBe(true);
    // With the box checked, the FULL error card stays visible and Go is enabled —
    // it is not collapsed to a one-line "overridden" note.
    const over = mount(<ImportConfirm {...base} mode="insert" shape={shape} shapeOverride />);
    const err = over.querySelector('[data-testid="import-shape-error"]');
    expect(err).toBeTruthy();
    expect(err!.textContent).toMatch(/blocked/i);
    expect(over.querySelector<HTMLInputElement>('[data-testid="shape-override"]')!.checked).toBe(
      true,
    );
    expect(over.querySelector<HTMLButtonElement>('[data-testid="import-go"]')!.disabled).toBe(
      false,
    );
    expect(over.querySelector('[data-testid="shape-overridden"]')).toBe(null);
  });

  // Redesign (2026-08-24): direction used to be stated in prose captions
  // ("in the file, not in the collection" / "in the collection, not in the
  // file") next to the Missing/Unexpected lists. Those captions are deleted
  // by design — the ledger table now states direction by COLUMN POSITION
  // (the "In the collection" / "In the file" headers), so the same fact is
  // asserted here structurally instead of via the old prose.
  it('states which side each error came from — positionally, via the ledger columns', () => {
    const shape = deriveShape([{ sku: 'A1', at: { $date: '2026-01-31T09:00:00.000Z' } }]);
    const root = mount(
      <ImportConfirm
        {...base}
        shape={shape}
        shapeCount={1}
        docs={[{ sku: 'B2', at: 'text', extra: 1 }]}
      />,
    );
    const err = root.querySelector('[data-testid="import-shape-error"]')!;
    const extraRow = err.querySelector('[data-testid="ledger-row"][data-path="extra"]')!;
    expect(extraRow.querySelector('.import-ledger-cell-collection')!.textContent).toMatch(
      /\(absent\)/,
    );
    expect(extraRow.querySelector('.import-ledger-cell-file')!.textContent).toMatch(/number/);
    const atRow = err.querySelector('[data-testid="ledger-row"][data-path="at"]')!;
    expect(atRow.querySelector('.import-ledger-cell-collection')!.textContent).toMatch(/date/i);
    expect(atRow.querySelector('.import-ledger-cell-file')!.textContent).toMatch(/string/i);
    expect(err.textContent).not.toMatch(/date → string/);
    expect(err.textContent).not.toMatch(/in the file, not in the collection/i);
  });

  it('names the missing side explicitly too — the collection column carries its type, the file column reads "(absent)"', () => {
    const shape = deriveShape([{ sku: 'A1', region: 'EU' }]);
    const root = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={1} docs={[{ sku: 'B2' }]} />,
    );
    const err = root.querySelector('[data-testid="import-shape-error"]')!;
    const row = err.querySelector('[data-testid="ledger-row"][data-path="region"]')!;
    expect(row.querySelector('.import-ledger-cell-collection')!.textContent).toMatch(/string/i);
    expect(row.querySelector('.import-ledger-cell-file')!.textContent).toMatch(/\(absent\)/);
    expect(err.textContent).not.toMatch(/in the collection, not in the file/i);
  });

  it('renders the ledger table: headers, root grouping (only when >1 row shares a root), row order, and the flat-cause summary', () => {
    // "key" and "address" each arrived as one flat column instead of their
    // nested leaves (the motivating case from the bug report); "updated"
    // is a lone wrong-type finding and must NOT get a group heading.
    const shape = deriveShape([
      {
        key: { code: 'A', system: 'B' },
        address: { line: ['L1'], city: 'C' },
        updated: { $date: '2026-01-01T00:00:00.000Z' },
      },
    ]);
    const root = mount(
      <ImportConfirm
        {...base}
        shape={shape}
        shapeCount={500}
        docs={[{ key: 'flat-key', address: 'flat-address', updated: 'not-a-date' }]}
      />,
    );
    const err = root.querySelector('[data-testid="import-shape-error"]')!;

    const headers = [...err.querySelectorAll('.import-ledger th')].map((th) => th.textContent);
    expect(headers).toEqual(['Field', 'In the collection', 'In the file']);

    const groupHeadings = [...err.querySelectorAll('.import-ledger-group-row')].map(
      (tr) => tr.textContent,
    );
    expect(groupHeadings).toEqual(['key', 'address']); // none for the lone "updated" finding

    const rowPaths = [...err.querySelectorAll('[data-testid="ledger-row"]')].map((tr) =>
      tr.getAttribute('data-path'),
    );
    expect(rowPaths).toEqual([
      'key.code',
      'key.system',
      'key',
      'address.line',
      'address.city',
      'address',
      'updated',
    ]);

    const flat = err.querySelector('[data-testid="import-shape-flat-causes"]')!.textContent;
    expect(flat).toMatch(/2 fields arrived flat/);
    expect(flat).toMatch(/key/);
    expect(flat).toMatch(/\(2 nested\)/);
    expect(flat).toMatch(/address/);
  });

  it('says "1 field arrived flat" (singular) for exactly one flattened cause', () => {
    const shape = deriveShape([{ key: { code: 'A' }, sku: 'X' }]);
    const root = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={1} docs={[{ key: 'flat', sku: 'X' }]} />,
    );
    const flat = root.querySelector('[data-testid="import-shape-flat-causes"]')!.textContent;
    expect(flat).toMatch(/^1 field arrived flat/);
    expect(flat).not.toMatch(/fields arrived flat/);
    expect(flat).toMatch(/\(1 nested\)/);
  });

  it('tags a whitespace row as "spelling" so it is not misread as a type, and renders an absent side as "(absent)", muted and italic', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const root = mount(
      <ImportConfirm {...base} shape={shape} shapeCount={1} docs={[{ 'sku ': 'B2', price: 20 }]} />,
    );
    const err = root.querySelector('[data-testid="import-shape-error"]');
    const wsRow = err!.querySelector('[data-testid="ledger-row"][data-kind="whitespace"]');
    expect(wsRow!.querySelector('.import-ledger-tag')!.textContent).toBe('spelling');
    // No finding in this fixture produces an absent cell on both sides at
    // once, but every missing/unexpected row has exactly one — assert it is
    // rendered via the shared muted+italic AbsentValue vocabulary (the same
    // "(absent)" the import preview and export preview grids use), not bare
    // text and not the literal string "null" (which is a real type name and
    // stays mono/plain — see LedgerCell's own comment).
    const shape2 = deriveShape([{ sku: 'A1', region: 'EU' }]);
    const root2 = mount(
      <ImportConfirm {...base} shape={shape2} shapeCount={1} docs={[{ sku: 'B2' }]} />,
    );
    const missingRow = root2.querySelector('[data-testid="ledger-row"][data-path="region"]');
    const absent = missingRow!.querySelector('.import-ledger-cell-file .csv-cell-missing');
    expect(absent).toBeTruthy();
    expect(absent!.textContent).toBe('(absent)');
  });

  it('renders the restore summary when one is given, and nothing when it is null', () => {
    const withIt = mount(
      <ImportConfirm
        {...base}
        restoreSummary="Restored 9 nested columns to match the collection."
      />,
    );
    expect(withIt.querySelector('[data-testid="import-restore-summary"]')!.textContent).toMatch(
      /Restored 9 nested columns/,
    );
    const without = mount(<ImportConfirm {...base} restoreSummary={null} />);
    expect(without.querySelector('[data-testid="import-restore-summary"]')).toBe(null);
  });
});
