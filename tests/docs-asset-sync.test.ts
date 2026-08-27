// @vitest-environment jsdom
//
// Controller ruling 15: resolving an asset is a targeted live-DOM patch (`syncAssets`), never a
// re-render of the cached tree. These tests cover both halves: the pure DOM-patching function on
// its own (fast, no Preact), and the DocView wiring that makes a completed fetch actually repaint
// the page WITHOUT tearing down the source-preview modal or the hover-preview timer — the exact
// regression a previous round of this task introduced and review caught.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { syncAssets } from '../src/docs/assetSync.js';
import DocView from '../src/docs/components/DocView.jsx';
import { createAssetStore } from '../src/fabry/architect/assets.js';

function markedRef(ref: string) {
  const root = document.createElement('div');
  const img = document.createElement('img');
  img.setAttribute('data-asset-ref', ref);
  root.appendChild(img);
  return root;
}

describe('syncAssets', () => {
  it('turns a marked reference into an image once the store has it cached', () => {
    const root = markedRef('assets/diagram.png');
    const resolve = vi.fn();
    const store = {
      lookup: () => ({}),
      peek: () => ({ row: { name: 'diagram.png' }, url: 'blob:xyz' }),
      resolve,
      pin: vi.fn(),
    };
    syncAssets(root, store);
    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:xyz');
    expect(img.getAttribute('title')).toBe('diagram.png');
    expect(img.getAttribute('data-asset-ref')).toBe('assets/diagram.png');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('sets src/title on the EXISTING <img>, preserving alt/width/class instead of rebuilding it', () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('data-asset-ref', 'assets/diagram.png');
    img.setAttribute('alt', 'A hand-drawn diagram');
    img.setAttribute('width', '480');
    img.setAttribute('class', 'figure');
    root.appendChild(img);
    const store = {
      lookup: () => ({}),
      peek: () => ({ row: { name: 'diagram.png' }, url: 'blob:xyz' }),
      resolve: vi.fn(),
      pin: vi.fn(),
    };
    syncAssets(root, store);
    const out = root.querySelector('img')!;
    expect(out).toBe(img); // same node: an in-place attribute update, not a replaceWith
    expect(out.getAttribute('src')).toBe('blob:xyz');
    expect(out.getAttribute('alt')).toBe('A hand-drawn diagram');
    expect(out.getAttribute('width')).toBe('480');
    expect(out.getAttribute('class')).toBe('figure');
  });

  it('paints "unavailable" for a failed fetch, and never starts a redundant one', () => {
    const root = markedRef('assets/diagram.png');
    const resolve = vi.fn();
    const store = {
      lookup: () => ({}),
      peek: () => ({ row: { name: 'diagram.png' }, error: '401' }),
      resolve,
      pin: vi.fn(),
    };
    syncAssets(root, store);
    const pill = root.querySelector('.state-label.state-error')!;
    expect(pill.textContent).toContain('unavailable');
    expect(pill.getAttribute('data-asset-ref')).toBe('assets/diagram.png');
    expect(resolve).not.toHaveBeenCalled();
  });

  // RULING 40. `lookup` returns null both for a file nobody uploaded and for an index nobody could
  // read, so the pill machine could not tell the two apart and painted the FILE's verdict for the
  // INDEX's failure. `ArchitectApp`'s load effect runs once, so nothing re-reads: every image in the
  // document column read "— not published" for the rest of the session, and recovery needed a rail
  // tab the reader may never open.
  it('names the index when the index is what failed, instead of blaming the file', () => {
    const root = markedRef('assets/diagram.png');
    const store = {
      lookup: () => null,
      peek: () => null,
      resolve: vi.fn(),
      pin: vi.fn(),
      stats: () => ({ indexError: '401 Unauthorized' }),
    };
    syncAssets(root, store);
    const pill = root.querySelector('.state-label.state-error')!;
    expect(pill.textContent).toBe(
      'assets/diagram.png — the file index could not be read (401 Unauthorized)',
    );
    expect(pill.getAttribute('data-asset-state')).toBe('index-error');
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('still says "not published" for a store that offers no stats at all', () => {
    // `stats` is optional so a plain table can stand in for the store — the same seam
    // `assetPrefetch` declares. An absent reader is not an index failure.
    const root = markedRef('assets/diagram.png');
    syncAssets(root, { lookup: () => null, peek: () => null, resolve: vi.fn(), pin: vi.fn() });
    expect(root.querySelector('.state-label')!.textContent).toContain('not published');
  });

  it('still says "not published" when stats itself throws', () => {
    const root = markedRef('assets/diagram.png');
    syncAssets(root, {
      lookup: () => null,
      peek: () => null,
      resolve: vi.fn(),
      pin: vi.fn(),
      stats: () => {
        throw new Error('no');
      },
    });
    expect(root.querySelector('.state-label')!.textContent).toContain('not published');
  });

  it('names a lookup that threw, in preference to the index error', () => {
    const root = markedRef('assets/diagram.png');
    syncAssets(root, {
      lookup: () => {
        throw new Error('the index is not a map');
      },
      peek: () => null,
      resolve: vi.fn(),
      pin: vi.fn(),
      stats: () => ({ indexError: '401 Unauthorized' }),
    });
    expect(root.querySelector('.state-label')!.textContent).toBe(
      'assets/diagram.png — the file index could not be read (the index is not a map)',
    );
  });

  it('repaints when the same failure comes back with a different reason', () => {
    // The state is unchanged, so a state-only idempotence check would leave the FIRST reason on
    // screen after a retry failed differently — a stale sentence about a live condition.
    const root = markedRef('assets/diagram.png');
    let indexError = '401 Unauthorized';
    const store = {
      lookup: () => null,
      peek: () => null,
      resolve: vi.fn(),
      pin: vi.fn(),
      stats: () => ({ indexError }),
    };
    syncAssets(root, store);
    indexError = '502 Bad Gateway';
    syncAssets(root, store);
    expect(root.querySelector('.state-label')!.textContent).toContain('502 Bad Gateway');
    expect(root.querySelectorAll('.state-label')).toHaveLength(1);
  });

  it('self-heals from an index failure once the read succeeds', () => {
    const root = markedRef('assets/diagram.png');
    let indexError: string | null = '401 Unauthorized';
    let held: any = null;
    const store = {
      lookup: () => (indexError ? null : {}),
      peek: () => held,
      resolve: vi.fn(),
      pin: vi.fn(),
      stats: () => ({ indexError }),
    };
    syncAssets(root, store);
    expect(root.querySelector('.state-label')!.getAttribute('data-asset-state')).toBe(
      'index-error',
    );
    indexError = null;
    held = { row: { name: 'diagram.png' }, url: 'blob:xyz' };
    syncAssets(root, store);
    expect(root.querySelector('.state-label')).toBe(null);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('blob:xyz');
  });

  // A row existed and its FETCH failed. That is a per-asset failure whatever the index is doing, so
  // it keeps its own sentence rather than being folded into the index's.
  it('keeps "unavailable" for a failed fetch even while the index is broken', () => {
    const root = markedRef('assets/diagram.png');
    syncAssets(root, {
      lookup: () => ({}),
      peek: () => ({ row: { name: 'diagram.png' }, error: '404' }),
      resolve: vi.fn(),
      pin: vi.fn(),
      stats: () => ({ indexError: '401 Unauthorized' }),
    });
    expect(root.querySelector('.state-label')!.textContent).toContain('unavailable');
  });

  it('paints "not published" when no row exists at all', () => {
    const root = markedRef('assets/missing.png');
    const resolve = vi.fn();
    const store = { lookup: () => null, peek: () => null, resolve, pin: vi.fn() };
    syncAssets(root, store);
    const pill = root.querySelector('.state-label.state-error')!;
    expect(pill.textContent).toContain('assets/missing.png');
    expect(pill.textContent).toContain('not published');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('is the only thing that starts a fetch, and paints nothing while it is pending', () => {
    const root = markedRef('assets/diagram.png');
    const resolve = vi.fn();
    const store = { lookup: () => ({}), peek: () => null, resolve, pin: vi.fn() };
    syncAssets(root, store);
    expect(resolve).toHaveBeenCalledWith('assets/diagram.png');
    expect(root.querySelector('img')!.getAttribute('src')).toBe(null);
    expect(root.querySelector('.state-label')).toBe(null);
  });

  it('attaches a catch to the fire-and-forget resolve, so a rejecting store is never an unhandled rejection', async () => {
    const root = markedRef('assets/diagram.png');
    const store = {
      lookup: () => ({}),
      peek: () => null,
      resolve: () => Promise.reject(new Error('boom')),
      pin: vi.fn(),
    };
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      syncAssets(root, store);
      // Let the rejection (and any unhandled-rejection detection) actually run.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('clears a stale blob: src instead of leaving a broken picture once its cache entry is gone', () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('data-asset-ref', 'assets/diagram.png');
    img.setAttribute('src', 'blob:revoked-and-gone');
    root.appendChild(img);
    const resolve = vi.fn();
    const store = { lookup: () => ({}), peek: () => null, resolve, pin: vi.fn() };
    syncAssets(root, store);
    expect(root.querySelector('img')!.getAttribute('src')).toBe(null);
    expect(root.querySelector('.state-label')).toBe(null); // still just pending, not an error
    expect(resolve).toHaveBeenCalledWith('assets/diagram.png');
  });

  it('only touches an img or pill carrying data-asset-ref, never an unrelated element with the attribute', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-asset-ref="assets/x.png">custom content</div>';
    const resolve = vi.fn();
    const store = { lookup: () => null, peek: () => null, resolve, pin: vi.fn() };
    syncAssets(root, store);
    expect(root.innerHTML).toBe('<div data-asset-ref="assets/x.png">custom content</div>');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('is idempotent: an unchanged store makes zero further DOM mutations', () => {
    const root = markedRef('assets/diagram.png');
    const store = {
      lookup: () => ({}),
      peek: () => ({ row: { name: 'diagram.png' }, url: 'blob:xyz' }),
      resolve: vi.fn(),
      pin: vi.fn(),
    };
    syncAssets(root, store);
    const img1 = root.querySelector('img');
    syncAssets(root, store);
    expect(root.querySelector('img')).toBe(img1);
  });

  it('self-heals: an "unavailable" pill becomes an image once a retry succeeds', () => {
    const root = markedRef('assets/diagram.png');
    let failed = true;
    const store = {
      lookup: () => ({}),
      peek: () =>
        failed
          ? { row: { name: 'diagram.png' }, error: '401' }
          : { row: { name: 'diagram.png' }, url: 'blob:xyz' },
      resolve: vi.fn(),
      pin: vi.fn(),
    };
    syncAssets(root, store);
    expect(root.querySelector('.state-label.state-error')!.textContent).toContain('unavailable');

    failed = false;
    syncAssets(root, store);
    const img = root.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('blob:xyz');
    expect(img!.getAttribute('data-asset-ref')).toBe('assets/diagram.png');
  });

  it('self-heals the other way too: an image reverts to a pill if the row disappears', () => {
    const root = markedRef('assets/diagram.png');
    let gone = false;
    const store = {
      lookup: () => (gone ? null : {}),
      peek: () => (gone ? null : { row: { name: 'diagram.png' }, url: 'blob:xyz' }),
      resolve: vi.fn(),
      pin: vi.fn(),
    };
    syncAssets(root, store);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('blob:xyz');

    gone = true;
    syncAssets(root, store);
    expect(root.querySelector('img')).toBe(null);
    const pill = root.querySelector('.state-label.state-error')!;
    expect(pill.textContent).toContain('not published');
    expect(pill.getAttribute('data-asset-ref')).toBe('assets/diagram.png');
  });

  it('ignores elements with no data-asset-ref, and treats a missing store as a no-op', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>hello</p>';
    expect(() => syncAssets(root, null)).not.toThrow();
    expect(() =>
      syncAssets(null, { lookup: () => null, peek: () => null, resolve: vi.fn(), pin: vi.fn() }),
    ).not.toThrow();
    expect(root.innerHTML).toBe('<p>hello</p>');
  });

  it('pins every ref it painted, replacing the previous pinned set wholesale', () => {
    const root = document.createElement('div');
    const a = document.createElement('img');
    a.setAttribute('data-asset-ref', 'assets/a.png');
    const b = document.createElement('img');
    b.setAttribute('data-asset-ref', 'assets/b.png');
    root.append(a, b);
    const pin = vi.fn();
    const store = { lookup: () => ({}), peek: () => null, resolve: vi.fn(), pin };
    syncAssets(root, store);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith(['assets/a.png', 'assets/b.png']);

    root.removeChild(b);
    syncAssets(root, store);
    expect(pin).toHaveBeenLastCalledWith(['assets/a.png']); // b dropped out — not merged in
  });
});

describe('syncAssets + createAssetStore: eviction never fights the sync effect (ruling 16)', () => {
  beforeEach(() => {
    (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:' + Math.random());
    (globalThis as any).URL.revokeObjectURL = vi.fn();
  });

  const bigRow = (key: string, size: number, id: number) => ({
    _id: key,
    kind: 'asset',
    documentId: id,
    mime: 'image/png',
    name: key.split('/').pop(),
    size,
    sha256: `sha-${id}`,
    aliases: [],
  });

  it('resolves each image exactly once even past maxBytes, and a second pass fetches nothing further', async () => {
    // 18 bytes of assets against a 10-byte budget: without ruling 16, resolving the third would
    // evict the first, whose still-live <img> would be re-requested on the next pass, evicting
    // the second in turn — forever.
    const rows = [
      bigRow('assets/a.png', 6, 1),
      bigRow('assets/b.png', 6, 2),
      bigRow('assets/c.png', 6, 3),
    ];
    const fetchBytes = vi.fn(async () => new Blob(['x']));
    const store = createAssetStore({
      find: async () => ({ result: rows }),
      fetchBytes,
      maxBytes: 10,
    });
    await store.load();

    const root = document.createElement('div');
    for (const r of rows) {
      const img = document.createElement('img');
      img.setAttribute('data-asset-ref', r._id);
      root.appendChild(img);
    }

    syncAssets(root, store); // pass 1: nothing cached yet — kicks off all three fetches, and pins all three
    await Promise.all(rows.map((r) => store.resolve(r._id))); // wait for them to actually settle

    expect(fetchBytes).toHaveBeenCalledTimes(3);
    // The budget (10) is deliberately exceeded: every ref was pinned by pass 1 (the reader is
    // looking at all three), so none of the three evicted the others as they resolved.
    expect(store.stats().bytes).toBe(18);

    syncAssets(root, store); // pass 2: paints the now-cached srcs; nothing new to fetch
    for (const r of rows) {
      const img = root.querySelector(`img[data-asset-ref="${r._id}"]`)!;
      expect(img.getAttribute('src')).toMatch(/^blob:/);
    }
    expect(fetchBytes).toHaveBeenCalledTimes(3);

    // The termination test: a THIRD pass over the SAME, fully-resolved DOM must issue no further
    // fetches either. This is exactly the assertion that would have caught the unbounded loop —
    // without pinning, resolving any one of the three would have evicted another, whose still-live
    // <img> this pass would then find gone and re-request, forever.
    syncAssets(root, store);
    await Promise.all(rows.map((r) => store.resolve(r._id)));
    expect(fetchBytes).toHaveBeenCalledTimes(3);
    expect(store.stats().bytes).toBe(18);
  });
});

describe('DocView + syncAssets: the repaint never closes the source modal or rebuilds the tree', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:' + Math.random());
    (globalThis as any).URL.revokeObjectURL = vi.fn();
  });

  const ROW = {
    _id: 'assets/diagram.png',
    kind: 'asset',
    documentId: 42,
    mime: 'image/png',
    name: 'diagram.png',
    size: 10,
    sha256: 's',
    aliases: [],
  };

  it('turns a pending reference into an image after resolve() completes, without the adopt effect running again', async () => {
    let releaseFetch: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const store = createAssetStore({
      find: async () => ({ result: [ROW] }),
      fetchBytes: async () => {
        await gate;
        return new Blob(['x']);
      },
    });
    await store.load();

    const replaceChildrenSpy = vi.spyOn(Element.prototype, 'replaceChildren');

    const root = document.createElement('div');
    document.body.appendChild(root);
    act(() => {
      render(
        h(DocView, {
          docId: 'solo',
          text: '# Title\n\n![shot](assets/diagram.png)\n',
          assets: store,
        }),
        root,
      );
    });

    // While the fetch syncAssets itself kicked off is in flight: a bare, src-less <img> — never
    // a broken-image glyph, and never a pill (there is nothing wrong to report yet).
    await vi.waitFor(() => expect(root.querySelector('img[data-asset-ref]')).toBeTruthy());
    expect(root.querySelector('img')!.getAttribute('src')).toBe(null);
    expect(root.querySelector('.state-label')).toBe(null);
    const heading = root.querySelector('h1');
    expect(heading).toBeTruthy();
    const adoptRunsAfterMount = replaceChildrenSpy.mock.calls.length;
    expect(adoptRunsAfterMount).toBeGreaterThan(0);

    releaseFetch!();
    await store.resolve('assets/diagram.png');

    await vi.waitFor(() =>
      expect(root.querySelector('img')!.getAttribute('src')).toMatch(/^blob:/),
    );
    // Same node: the adopt effect did NOT tear down and rebuild the section — only the one
    // `[data-asset-ref]` element was patched.
    expect(root.querySelector('h1')).toBe(heading);
    expect(replaceChildrenSpy.mock.calls.length).toBe(adoptRunsAfterMount);

    replaceChildrenSpy.mockRestore();
  });

  it('goes from "not published" to "unavailable" as the index loads and the fetch then fails', async () => {
    let releaseFind: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFind = resolve;
    });
    const store = createAssetStore({
      find: async () => {
        await gate;
        return { result: [ROW] };
      },
      fetchBytes: async () => {
        throw new Error('401');
      },
    });

    const root = document.createElement('div');
    document.body.appendChild(root);
    act(() => {
      render(
        h(DocView, { docId: 'solo', text: '![shot](assets/diagram.png)\n', assets: store }),
        root,
      );
    });

    await vi.waitFor(() =>
      expect(root.querySelector('.state-label.state-error')!.textContent).toContain(
        'not published',
      ),
    );

    const loaded = store.load();
    releaseFind!();
    await loaded;

    await vi.waitFor(() =>
      expect(root.querySelector('.state-label.state-error')!.textContent).toContain('unavailable'),
    );
    expect(root.querySelector('.state-label.state-error')!.textContent).not.toContain(
      'not published',
    );
  });

  it('the source-preview modal survives a resolve that happens while it is open', async () => {
    const store = createAssetStore({
      find: async () => ({ result: [ROW] }),
      fetchBytes: async () => new Blob(['x']),
    });
    await store.load();

    const domain = 'https://example-org.rossum.app';
    const root = document.createElement('div');
    document.body.appendChild(root);
    act(() => {
      render(
        h(DocView, {
          docId: 'solo',
          domain,
          text: `[hook](${domain}/api/v1/hooks/42)\n\n![shot](assets/diagram.png)\n`,
          assets: store,
        }),
        root,
      );
    });

    await vi.waitFor(() => expect(root.querySelector('a')).toBeTruthy());
    const link = [...root.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('/api/v1/'),
    )!;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const overlay = document.getElementById('srcOverlay')!;
    await vi.waitFor(() => expect(overlay.classList.contains('open')).toBe(true));

    await store.resolve('assets/diagram.png');
    await vi.waitFor(() => expect(root.querySelector('img')).toBeTruthy());

    expect(overlay.classList.contains('open')).toBe(true);
  });
});
