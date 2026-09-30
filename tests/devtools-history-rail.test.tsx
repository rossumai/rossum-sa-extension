// tests/devtools-history-rail.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import HistoryRail from '../src/devtools/HistoryRail.jsx';

async function waitFor(fn: () => boolean, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

const REF = { type: 'hook' as const, id: 48, key: '/api/v1/hooks/48' };
const e = (version_id: number, over: any = {}) => ({
  version_id,
  object_type: 'hook',
  object_id: 48,
  version_event: 'update',
  changed_fields: ['config'],
  version_created_at: '2026-09-29T09:00:00Z',
  modifier_id: 7,
  ...over,
});
let root: HTMLDivElement;
afterEach(() => {
  render(null, root);
  root.remove();
});

function mount(props: any) {
  root = document.createElement('div');
  document.body.appendChild(root);
  render(
    <HistoryRail
      historyRef={REF}
      domain="https://org.rossum.app"
      users={new Map([[7, 'Jane Doe']])}
      selectedId={null}
      onSelect={vi.fn()}
      {...props}
    />,
    root,
  );
}

describe('HistoryRail', () => {
  it('lists versions under a Live row and selects one', async () => {
    const onSelect = vi.fn();
    const get = vi.fn(async () => ({
      pagination: { next: null },
      results: [e(3), e(2, { changed_fields: ['status'] })],
    }));
    mount({ get, onSelect });
    // Live + both versions: nothing is filtered out, status-only changes included.
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 3);
    const rows = root.querySelectorAll<HTMLButtonElement>('.rawjson-hist-row');
    expect(rows[2].textContent).toContain('status');
    expect(rows[0].textContent).toContain('Live');
    expect(rows[1].textContent).toContain('Jane Doe');
    rows[1].click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ version_id: 3 }));
    rows[0].click();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('names modifiers the history store did not resolve', async () => {
    const get = vi.fn(async (p: string) =>
      p.startsWith('/api/v1/users')
        ? { results: [{ id: 9, first_name: 'John', last_name: 'Roe' }] }
        : { pagination: { next: null }, results: [e(3, { modifier_id: 9 })] },
    );
    mount({ get });
    await waitFor(() => root.textContent!.includes('John Roe'));
    expect(get.mock.calls.some(([p]) => p.startsWith('/api/v1/users?id=9'))).toBe(true);
  });

  // A page that says there is a `next` offers Load more once its own rows are all shown.
  const full = () => Array.from({ length: 20 }, (_, i) => e(100 + i));
  const page = (results: any[], next: string | null) => ({ pagination: { next }, results });

  it('Load more appends the next page', async () => {
    const get = vi.fn(async (p: string) =>
      new URL(`https://x${p}`).searchParams.get('page') === '2'
        ? page([e(1, { modifier_id: 7 })], null)
        : page(full(), 'more'),
    );
    mount({ get });
    await waitFor(() => root.querySelector('.rawjson-hist-more') !== null);
    root.querySelector<HTMLButtonElement>('.rawjson-hist-more')!.click();
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 22);
    expect(root.querySelector('.rawjson-hist-more')).toBeNull();
  });

  it('a double-click on Load more makes one request', async () => {
    let release: (v: any) => void = () => {};
    const get = vi.fn((p: string) =>
      new URL(`https://x${p}`).searchParams.get('page') === '2'
        ? new Promise((r) => (release = r))
        : Promise.resolve(page(full(), 'more')),
    );
    mount({ get });
    await waitFor(() => root.querySelector('.rawjson-hist-more') !== null);
    const more = root.querySelector<HTMLButtonElement>('.rawjson-hist-more')!;
    more.click();
    more.click();
    expect(get).toHaveBeenCalledTimes(2); // page 1, then page 2 once
    release(page([e(1)], null));
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 22);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('drops a Load more that lands after switching to another object', async () => {
    const OTHER = { type: 'hook' as const, id: 51, key: '/api/v1/hooks/51' };
    let release: (v: any) => void = () => {};
    const get = vi.fn((p: string) => {
      const q = new URL(`https://x${p}`).searchParams;
      if (q.get('object_id') === '51')
        return Promise.resolve(page([e(900, { object_id: 51 })], null));
      if (q.get('page') === '2') return new Promise((r) => (release = r));
      return Promise.resolve(page(full(), 'more'));
    });
    mount({ get });
    await waitFor(() => root.querySelector('.rawjson-hist-more') !== null);
    root.querySelector<HTMLButtonElement>('.rawjson-hist-more')!.click();
    await waitFor(() => get.mock.calls.length === 2); // page 1, then the page 2 held open
    render(
      <HistoryRail
        historyRef={OTHER}
        get={get}
        domain="https://org.rossum.app"
        users={new Map([[7, 'Jane Doe']])}
        selectedId={null}
        onSelect={vi.fn()}
      />,
      root,
    );
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 2); // Live + v900
    release(page([e(1), e(0)], null));
    await new Promise((r) => setTimeout(r, 20));
    // The old object's page 2 landed after the switch and added nothing.
    expect(root.querySelectorAll('.rawjson-hist-row').length).toBe(2);
  });

  it('renders 20 of a 30-row page and reveals the rest without a request', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => e(200 + i));
    const get = vi.fn(async () => page(thirty, null));
    mount({ get });
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 21); // Live + 20
    root.querySelector<HTMLButtonElement>('.rawjson-hist-more')!.click();
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 31);
    expect(get).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.rawjson-hist-more')).toBeNull();
  });
});

describe('HistoryRail compared label', () => {
  it('labels the version the selected one is diffed against', async () => {
    const get = vi.fn(async () => ({ pagination: { next: null }, results: [e(3), e(2), e(1)] }));
    mount({ get, selectedId: 3, comparedId: 2 });
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 4);
    const rows = [...root.querySelectorAll('.rawjson-hist-row')];
    expect(rows.map((r) => !!r.querySelector('.rawjson-hist-tag'))).toEqual([
      false, // Live
      false, // v3, the selected one
      true, // v2, compared
      false,
    ]);
    expect(rows[1].classList.contains('selected')).toBe(true);
  });
});

describe('HistoryRail Diff link', () => {
  it("puts Diff ↗ on the selected version's row only, to Rossum's page for that version", async () => {
    const get = vi.fn(async () => ({ pagination: { next: null }, results: [e(3), e(2)] }));
    mount({ get, selectedId: 3 });
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 3);
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a.rawjson-hist-diff')];
    expect(links).toHaveLength(1);
    expect(links[0].closest('.rawjson-hist-item')!.querySelector('.selected')).not.toBeNull();
    expect(links[0].href).toBe(
      'https://org.rossum.app/settings/configuration-changelog/3?objectType=hook&objectId=48',
    );
    expect(links[0].target).toBe('_blank');
  });
});

describe('HistoryRail first page', () => {
  it('starts from the history store page without fetching it again', async () => {
    const get = vi.fn(async (p: string) =>
      new URL(`https://x${p}`).searchParams.get('page') === '2'
        ? { pagination: { next: null }, results: [e(1)] }
        : { pagination: { next: null }, results: [] },
    );
    const entries = Array.from({ length: 20 }, (_, i) => e(100 + i));
    mount({ get, firstPage: { entries, total: 21 } });
    expect(root.querySelectorAll('.rawjson-hist-row').length).toBe(21); // Live + 20, at once
    expect(get).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('.rawjson-hist-more')!.click(); // total says a page 2
    await waitFor(() => root.querySelectorAll('.rawjson-hist-row').length === 22);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
