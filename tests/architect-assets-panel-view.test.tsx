// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { signal } from '@preact/signals';

import * as store from '../src/fabry/architect/store.js';
import { createAssetStore } from '../src/fabry/architect/assets.js';
import AssetsPanel from '../src/fabry/architect/components/AssetsPanel.jsx';
import { deliverable } from './support/architect.js';

// The panel drives a store, never the network: every test here injects one, so nothing in this
// file can reach Data Storage or the Rossum API. The one real instance is store.assets, and the
// reason there is exactly one is asserted in architect-assets-rail.test.tsx.
const row = (key: string, extra: Record<string, any> = {}) => ({
  key,
  documentId: 1,
  mime: 'image/png',
  name: key.split('/').pop(),
  size: 1024,
  sha256: 'sha-' + key,
  aliases: [] as string[],
  uploadedAt: null,
  ...extra,
});

function fakeStore(rows: any[]) {
  const version = signal(0);
  const list = [...rows];
  const byRef = new Map<string, any>();
  for (const r of list) {
    byRef.set(r.key, r);
    for (const a of r.aliases) byRef.set(a, r);
  }
  return {
    load: vi.fn(async () => {}),
    entries: () => [...list],
    lookup: (href: string) => byRef.get(String(href).split('#')[0]) || null,
    peek: () => null,
    resolve: vi.fn(async (href: string) => ({ row: byRef.get(href), url: 'blob:' + href })),
    pin: vi.fn(),
    version: () => version.value,
    // The store bumps this on every upload, delete and resolve; the tests that care about a
    // REPAINT (rather than about a write) reach for it directly.
    bump: () => {
      version.value += 1;
    },
    stats: () => ({ bytes: 0, entries: 0, indexed: byRef.size, indexError: null as any }),
    upload: vi.fn(async (f: File) => {
      const r = row('assets/' + f.name, { name: f.name });
      list.push(r);
      byRef.set(r.key, r);
      version.value += 1;
      return { row: r, reused: false };
    }),
    remove: vi.fn(async (key: string) => {
      const i = list.findIndex((r) => r.key === key);
      if (i >= 0) list.splice(i, 1);
      byRef.delete(key);
      version.value += 1;
    }),
  };
}

let mounted: any[] = [];
function mount(props: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<AssetsPanel {...props} />, root);
  });
  mounted.push(root);
  return root;
}
function rerender(root: any, props: any) {
  act(() => {
    render(<AssetsPanel {...props} />, root);
  });
}

const groupOf = (root: any, kind: string) =>
  root.querySelector(`.fabry-arch-asset-group.${kind}`) as HTMLElement | null;
const keysIn = (root: any, kind: string) =>
  [...(groupOf(root, kind)?.querySelectorAll('.fabry-arch-asset-row') || [])].map((el) =>
    (el as HTMLElement).getAttribute('data-asset-key'),
  );
const act$ = (root: any, what: string) =>
  root.querySelector(`[data-act="${what}"]`) as HTMLButtonElement;

const noteText = (root: any) =>
  (root.querySelector('.fabry-arch-asset-note') as HTMLElement | null)?.textContent || '';

/** Microtask flushes until a condition holds. `settle` below waits on the header's busy flag, which
 *  a batch the index killed never clears — the drop target stays refused. */
async function flush(until: () => boolean) {
  for (let i = 0; i < 200 && !until(); i += 1) await act(async () => {});
}

// One `await act()` flushes a microtask or two, not a whole batch: the panel awaits each upload in
// turn, so a multi-file batch has to be driven until it says it is done — which is what the busy
// flag on the header actions is.
async function settle(root: any) {
  for (let i = 0; i < 500 && act$(root, 'add').disabled; i += 1) {
    await act(async () => {});
  }
}

beforeEach(() => {
  for (const root of mounted) act(() => render(null, root));
  mounted = [];
  document.body.innerHTML = '';
  store.deliverables.value = [
    deliverable({ id: 'd1', text: '![a](assets/a.png)', title: 'One', titleSource: 'manual' }),
    deliverable({ id: 'd2', text: '[b](assets/b.png)', title: 'Two', titleSource: 'manual' }),
  ];
});

describe('AssetsPanel', () => {
  const ROWS = [row('assets/a.png'), row('assets/b.png'), row('assets/orphan.csv')];

  it('leads with the files the deliverable in view references, and names where the others are used', () => {
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    expect(keysIn(root, 'here')).toEqual(['assets/a.png']);
    expect(keysIn(root, 'elsewhere')).toEqual(['assets/b.png']);
    expect(keysIn(root, 'unused')).toEqual(['assets/orphan.csv']);
    expect(groupOf(root, 'elsewhere')!.querySelector('.fabry-arch-asset-in')!.textContent).toBe(
      'Two',
    );
    expect(groupOf(root, 'unused')!.querySelector('.fabry-arch-asset-pill.unused')).toBeTruthy();
  });

  it('counts the files and their total in the header', () => {
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    expect(root.querySelector('.fabry-arch-asset-count')!.textContent).toBe('3 files · 3 KB');
  });

  it('shows each row its extension, size and how many deliverables reference it', () => {
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    const first = groupOf(root, 'here')!.querySelector('.fabry-arch-asset-row')!;
    expect(first.querySelector('.fabry-arch-asset-ext')!.textContent).toBe('png');
    expect(first.querySelector('.fabry-arch-asset-name')!.textContent).toBe('a.png');
    expect(first.querySelector('.fabry-arch-asset-meta')!.textContent).toBe('1 KB · 1 ref');
  });

  // Ruling D4: the rail follows the scroll, so the list must re-sort on a new target WITHOUT
  // remounting — which is exactly what a `key` on the panel would have destroyed.
  it('re-sorts when the deliverable in view changes, without reloading the index', () => {
    const assets = fakeStore(ROWS);
    const root = mount({ currentId: 'd1', assets });
    expect(keysIn(root, 'here')).toEqual(['assets/a.png']);
    rerender(root, { currentId: 'd2', assets });
    expect(keysIn(root, 'here')).toEqual(['assets/b.png']);
    expect(keysIn(root, 'elsewhere')).toEqual(['assets/a.png']);
    expect(assets.load).toHaveBeenCalledTimes(1);
  });

  it('filters by name across every group', () => {
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    const filter = root.querySelector('.fabry-arch-asset-filter') as HTMLInputElement;
    act(() => {
      filter.value = 'orphan';
      filter.dispatchEvent(new Event('input'));
    });
    expect(groupOf(root, 'here')).toBe(null);
    expect(keysIn(root, 'unused')).toEqual(['assets/orphan.csv']);
  });

  it('says so plainly when there is nothing yet', () => {
    const root = mount({ currentId: 'd1', assets: fakeStore([]) });
    expect(root.textContent).toMatch(/No files yet/i);
    expect(act$(root, 'download-all').disabled).toBe(true);
  });

  it('surfaces an index that could not be read instead of an empty list', () => {
    const assets = fakeStore([]);
    assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError: 'Session expired.' });
    const root = mount({ currentId: 'd1', assets });
    expect(root.querySelector('.fabry-arch-asset-error')!.textContent).toMatch(/Session expired/);
  });

  // F1: a transient failure is recoverable in the store, so the panel must offer the recovery.
  it('offers a retry beside the error, which asks the store to read the index again', async () => {
    const assets = fakeStore([]);
    assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError: 'Session expired.' });
    const root = mount({ currentId: 'd1', assets });
    expect(assets.load).toHaveBeenCalledTimes(1);
    await act(async () => {
      act$(root, 'retry').click();
    });
    expect(assets.load).toHaveBeenCalledTimes(2);
  });

  // A failed read bumps the version, which repaints this panel. If that repaint re-issued the
  // read, the retry above would be a loop rather than a button: the load effect is keyed on
  // [assets] precisely so it is not.
  it('does not re-read the index when a version bump repaints it', async () => {
    const assets = fakeStore([]);
    assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError: 'Session expired.' });
    const root = mount({ currentId: 'd1', assets });
    await act(async () => {
      assets.bump();
    });
    expect(root.querySelector('.fabry-arch-asset-error')).toBeTruthy();
    expect(assets.load).toHaveBeenCalledTimes(1);
  });

  it('uploads what the picker returns, and reports each file', async () => {
    const assets = fakeStore(ROWS);
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    expect(assets.upload).toHaveBeenCalledTimes(1);
    expect((assets.upload.mock.calls[0][0] as File).name).toBe('shot.png');
    expect(root.querySelector('.fabry-arch-asset-log')!.textContent).toMatch(/shot\.png/);
    expect(root.querySelector('.fabry-arch-asset-log')!.textContent).toMatch(/added/);
  });

  // D9: de-duplication is something the user SEES, not something that quietly happens.
  it('shows a reused pill when the same bytes are already published', async () => {
    const assets = fakeStore(ROWS);
    assets.upload = vi.fn(async () => ({ row: ROWS[0], reused: true }));
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'copy.png', { type: 'image/png' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    expect(root.querySelector('.fabry-arch-asset-pill.reused')!.textContent).toBe('reused');
  });

  it('takes a drop anywhere in the panel body', async () => {
    const assets = fakeStore(ROWS);
    const root = mount({ currentId: 'd1', assets });
    const panel = root.querySelector('.fabry-arch-asset') as HTMLElement;
    const ev: any = new Event('drop', { bubbles: true });
    ev.dataTransfer = { types: ['Files'], files: [new File(['x'], 'dropped.png')] };
    await act(async () => {
      panel.dispatchEvent(ev);
    });
    expect(assets.upload).toHaveBeenCalledTimes(1);
    expect((assets.upload.mock.calls[0][0] as File).name).toBe('dropped.png');
  });

  // The nesting counter, which is the whole reason the drag handling is a hook rather than four
  // inline lambdas: entering a child fires `dragenter` for it BEFORE `dragleave` for its parent, so
  // a flag would flicker off every time the pointer crossed a row.
  it('keeps the drop highlight while the pointer crosses a child element', () => {
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    const panel = root.querySelector('.fabry-arch-asset') as HTMLElement;
    const child = root.querySelector('.fabry-arch-asset-filter') as HTMLElement;
    const drag = (type: string, target: HTMLElement) => {
      const ev: any = new Event(type, { bubbles: true });
      ev.dataTransfer = { types: ['Files'], files: [] };
      act(() => {
        target.dispatchEvent(ev);
      });
    };
    drag('dragenter', panel);
    expect(panel.classList.contains('dragging')).toBe(true);
    drag('dragenter', child);
    drag('dragleave', panel);
    expect(panel.classList.contains('dragging')).toBe(true);
    drag('dragleave', child);
    expect(panel.classList.contains('dragging')).toBe(false);
  });

  // A deliverable dragged in the sidebar passes over this panel. It must not highlight, and the
  // drag must not be CLAIMED — a preventDefault here would take the drop away from whatever the
  // user was actually aiming at.
  it('ignores a drag that carries no files, so dragging a deliverable is not an upload', async () => {
    const assets = fakeStore(ROWS);
    const root = mount({ currentId: 'd1', assets });
    const panel = root.querySelector('.fabry-arch-asset') as HTMLElement;
    const fire = (type: string) => {
      const ev: any = new Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = { types: ['text/plain'], files: [] };
      act(() => {
        panel.dispatchEvent(ev);
      });
      return ev;
    };
    expect(fire('dragenter').defaultPrevented).toBe(false);
    expect(panel.classList.contains('dragging')).toBe(false);
    expect(fire('dragover').defaultPrevented).toBe(false);
    expect(fire('drop').defaultPrevented).toBe(false);
    expect(assets.upload).not.toHaveBeenCalled();
  });

  // The documented per-document ceiling. It lives in the STORE since Task 7, so that the editor's
  // paste path inherits it too — which is why this drives a REAL store over fake transports rather
  // than asserting that the panel turned the file away itself. What must not change is what the
  // user is told: the file is named, and so is the limit.
  it('names an oversized file and the limit, and sends nothing', async () => {
    let posted = 0;
    const assets = createAssetStore({
      find: async () => ({ result: [] }),
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha',
      postDocument: async () => {
        posted += 1;
        return 1;
      },
      insertRow: async () => {},
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    const root = mount({ currentId: 'd1', assets });
    const big = new File(['x'], 'huge.xlsx');
    Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [big], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    await settle(root);
    expect(posted).toBe(0);
    const failed = root.querySelector('.fabry-arch-asset-log-row.state-failed')!;
    expect(failed.textContent).toMatch(/huge\.xlsx/);
    expect(failed.textContent).toMatch(/over the 40 MB limit/);
  });

  // §5.5: informed, not blocked.
  it('names what still references a file before deleting it, and then deletes it anyway', async () => {
    const assets = fakeStore(ROWS);
    const root = mount({ currentId: 'd1', assets });
    const target = groupOf(root, 'here')!.querySelector('.fabry-arch-asset-row')!;
    act(() => {
      (target.querySelector('[data-act="delete"]') as HTMLElement).click();
    });
    const confirm = root.querySelector('.fabry-arch-asset-confirm')!;
    expect(confirm.textContent).toMatch(/Still referenced by One/);
    expect(assets.remove).not.toHaveBeenCalled();
    await act(async () => {
      (confirm.querySelector('[data-act="delete-confirm"]') as HTMLElement).click();
    });
    expect(assets.remove).toHaveBeenCalledWith('assets/a.png');
    expect(root.querySelector('.fabry-arch-asset-confirm')).toBe(null);
  });

  it('cancelling a delete leaves the file alone', async () => {
    const assets = fakeStore(ROWS);
    const root = mount({ currentId: 'd1', assets });
    act(() => {
      (groupOf(root, 'unused')!.querySelector('[data-act="delete"]') as HTMLElement).click();
    });
    act(() => {
      (root.querySelector('[data-act="delete-cancel"]') as HTMLElement).click();
    });
    expect(assets.remove).not.toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-asset-confirm')).toBe(null);
  });

  // D6: with no repository copy and no cross-organization copy, this is the only way an asset
  // leaves the org it was uploaded to — so it is a component, not a nice-to-have.
  it('downloads every file, one at a time, from the header', async () => {
    const assets = fakeStore(ROWS);
    const download = vi.fn(async () => null);
    const root = mount({ currentId: 'd1', assets, download });
    await act(async () => {
      act$(root, 'download-all').click();
    });
    expect(download.mock.calls.map((c: any[]) => c[1])).toEqual([
      'assets/a.png',
      'assets/b.png',
      'assets/orphan.csv',
    ]);
    expect(download.mock.calls.every((c: any[]) => c[0] === assets)).toBe(true);
  });

  // F4: the button sits beside the filter box, so it must mean what the filter shows.
  it('downloads what the filter shows, and says how many that is', async () => {
    const assets = fakeStore(ROWS);
    const download = vi.fn(async () => null);
    const root = mount({ currentId: 'd1', assets, download });
    const filter = root.querySelector('.fabry-arch-asset-filter') as HTMLInputElement;
    act(() => {
      filter.value = 'orphan';
      filter.dispatchEvent(new Event('input'));
    });
    expect(act$(root, 'download-all').textContent).toBe('⤓ Download 1');
    await act(async () => {
      act$(root, 'download-all').click();
    });
    expect(download.mock.calls.map((c: any[]) => c[1])).toEqual(['assets/orphan.csv']);
  });

  // F2's user-visible half: the store now serializes writes, and the header says so rather than
  // letting a second batch look like nothing happened.
  it('locks the header actions while a batch is running, and releases them after', async () => {
    (window as any).showDirectoryPicker = () => Promise.reject(new Error('cancelled'));
    try {
      const assets = fakeStore(ROWS);
      let finish = () => {};
      assets.upload = vi.fn(
        () =>
          new Promise((res) => {
            finish = () => res({ row: ROWS[0], reused: false });
          }),
      ) as any;
      const root = mount({ currentId: 'd1', assets });
      const input = root.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        value: [new File(['x'], 'shot.png')],
        configurable: true,
      });
      await act(async () => {
        input.dispatchEvent(new Event('change'));
      });
      expect(act$(root, 'add').disabled).toBe(true);
      expect(act$(root, 'add-folder').disabled).toBe(true);
      expect(act$(root, 'download-all').disabled).toBe(true);
      await act(async () => {
        finish();
      });
      expect(act$(root, 'add').disabled).toBe(false);
      expect(act$(root, 'add-folder').disabled).toBe(false);
      expect(act$(root, 'download-all').disabled).toBe(false);
    } finally {
      delete (window as any).showDirectoryPicker;
    }
  });

  // F6: a folder import of 200 files must not stack 200 rows above the list — and must not
  // silently drop what the reader was told happened either.
  it('caps the upload log, accounting for the rows it no longer shows', async () => {
    const assets = fakeStore([]);
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: Array.from({ length: 15 }, (_, i) => new File(['x'], `f${i}.png`)),
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    await settle(root);
    const log = root.querySelector('.fabry-arch-asset-log')!;
    expect(log.querySelectorAll('.fabry-arch-asset-log-row')).toHaveLength(12);
    expect(log.querySelector('.fabry-arch-asset-log-more')!.textContent).toBe(
      '3 earlier, not shown',
    );
    expect(log.textContent).toMatch(/f14\.png/);
    expect(log.textContent).not.toMatch(/f2\.png/);
  });

  // The same hole `message()` was fixed for, one file over: this panel is the only place an upload
  // failure is reported, so a `failed` row with an empty detail tells the user something went wrong
  // and nothing else. A transport rejecting falsily is what reaches it.
  it('gives a failed upload a reason even when the rejection carries none', async () => {
    const assets = fakeStore([]);
    assets.upload = vi.fn(async () => {
      throw '';
    }) as any;
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'quiet.png')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    await settle(root);
    const failed = root.querySelector('.fabry-arch-asset-log-row.state-failed')!;
    expect(failed.textContent).toMatch(/quiet\.png/);
    expect(failed.textContent).toMatch(/no reason given/);
  });

  // R2: this panel is the ONLY place an upload failure is ever reported. A cap that folds one into
  // "3 earlier, not shown" is a failure nobody ever hears about — F6's letter, against its intent.
  it('keeps a failed file in the log however many successes follow it', async () => {
    const assets = fakeStore([]);
    assets.upload = vi.fn(async (f: File) => {
      if (f.name === 'f0.png') throw new Error('larger than the service accepts');
      return { row: row('assets/' + f.name, { name: f.name }), reused: false };
    }) as any;
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: Array.from({ length: 15 }, (_, i) => new File(['x'], `f${i}.png`)),
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    await settle(root);
    const log = root.querySelector('.fabry-arch-asset-log')!;
    const failed = log.querySelector('.fabry-arch-asset-log-row.state-failed')!;
    expect(failed.textContent).toMatch(/f0\.png/);
    expect(failed.textContent).toMatch(/larger than the service accepts/);
    // A success was collapsed to make room for it, and the tail still accounts for that.
    expect(log.textContent).not.toMatch(/f1\.png/);
    expect(log.querySelector('.fabry-arch-asset-log-more')!.textContent).toBe(
      '3 earlier, not shown',
    );
  });

  // R3: the store refuses an upload it could not read the index for — otherwise a key allocated
  // against an empty index overwrites a row that exists server-side. This is what stops a user
  // walking into that refusal.
  it('takes uploading away while the index is unreadable, and says why', async () => {
    (window as any).showDirectoryPicker = () => Promise.reject(new Error('cancelled'));
    try {
      const assets = fakeStore([]);
      assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError: 'Session expired.' });
      const root = mount({ currentId: 'd1', assets });
      expect(act$(root, 'add').disabled).toBe(true);
      expect(act$(root, 'add-folder').disabled).toBe(true);

      const ev: any = new Event('drop', { bubbles: true });
      ev.dataTransfer = { types: ['Files'], files: [new File(['x'], 'dropped.png')] };
      await act(async () => {
        (root.querySelector('.fabry-arch-asset') as HTMLElement).dispatchEvent(ev);
      });
      expect(assets.upload).not.toHaveBeenCalled();
      expect(root.querySelector('.fabry-arch-asset-note')!.textContent).toMatch(/file index/i);
    } finally {
      delete (window as any).showDirectoryPicker;
    }
  });

  // The handler set `useFileDrop` builds is built ONCE, because CodeMirror captures it at view
  // construction — so its view of `enabled` has to come from `latest.current` and not from the
  // render that built it. An index that goes bad while the panel is OPEN is the case that
  // distinguishes the two: R3 above mounts already-blocked, which a frozen closure answers
  // correctly by accident.
  it('turns the drop target down when the index goes bad while the panel is open', async () => {
    const assets = fakeStore(ROWS);
    let indexError: any = null;
    assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError });
    const root = mount({ currentId: 'd1', assets });
    expect(act$(root, 'add').disabled).toBe(false);

    indexError = 'Session expired.';
    act(() => {
      assets.bump();
    });
    expect(act$(root, 'add').disabled).toBe(true);

    const ev: any = new Event('drop', { bubbles: true });
    ev.dataTransfer = { types: ['Files'], files: [new File(['x'], 'dropped.png')] };
    await act(async () => {
      (root.querySelector('.fabry-arch-asset') as HTMLElement).dispatchEvent(ev);
    });
    expect(assets.upload).not.toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-asset-note')!.textContent).toMatch(/file index/i);
  });

  // T2. `blocked` and this banner both read `indexError` as a flag, so a read that fails carrying
  // no message — `Promise.reject('')`, or a gateway with an empty body — must not leave it falsy:
  // the panel would then show nothing, leave the controls on, and hand the user an upload the store
  // refuses. That invariant belongs to the store, so this drives a REAL one over a fake transport
  // (no network, like every other store in this file) rather than stubbing `stats` with the answer.
  it('explains itself and takes uploading away when the read fails carrying no message', async () => {
    const assets = createAssetStore({
      find: () => Promise.reject(''),
      fetchBytes: async () => new Blob(['x']),
      sha256: async () => 'sha-of-a',
      postDocument: async () => 4242,
      insertRow: async () => {},
      updateRow: async () => {},
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });
    const root = mount({ currentId: 'd1', assets });
    for (let i = 0; i < 20 && !root.querySelector('.fabry-arch-asset-error'); i += 1) {
      await act(async () => {});
    }
    const banner = root.querySelector('.fabry-arch-asset-error');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toMatch(/no reason given/i);
    expect(act$(root, 'add').disabled).toBe(true);
  });

  // R4: a read is queued on the store's write chain, so one issued mid-batch waits behind every
  // upload in it. The error itself arrives mid-batch because `upload` asks for the index too.
  it('holds Retry while a batch is still running', async () => {
    const assets = fakeStore(ROWS);
    let indexError: any = null;
    assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError });
    let finish = () => {};
    assets.upload = vi.fn(
      () =>
        new Promise((res) => {
          finish = () => res({ row: ROWS[0], reused: false });
        }),
    ) as any;
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'shot.png')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    await act(async () => {
      indexError = 'Session expired.';
      assets.bump();
    });
    expect(act$(root, 'retry').disabled).toBe(true);
    await act(async () => {
      finish();
    });
    expect(act$(root, 'retry').disabled).toBe(false);
  });

  it('reports a download that could not be made rather than failing silently', async () => {
    const assets = fakeStore(ROWS);
    const download = vi.fn(async () => 'a.png: 404');
    const root = mount({ currentId: 'd1', assets, download });
    await act(async () => {
      (groupOf(root, 'here')!.querySelector('[data-act="download"]') as HTMLElement).click();
    });
    expect(root.querySelector('.fabry-arch-asset-note')!.textContent).toMatch(/404/);
  });

  it('copies the reference an author would write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    await act(async () => {
      (groupOf(root, 'here')!.querySelector('[data-act="copy"]') as HTMLElement).click();
    });
    expect(writeText).toHaveBeenCalledWith('assets/a.png');
  });

  // RULING 38 — the destructive case, end to end. A raw `<img>` with a width renders and prints,
  // and read as ZERO references here: the file sat under "Referenced by nothing" with an `unused`
  // pill, and the delete confirmation SAID "Referenced by nothing" about a file that is referenced.
  // Per design §2 the bytes exist in exactly one place — no git copy, no cross-organization copy.
  it('counts a raw <img> with a width, so the delete confirmation cannot say the opposite', () => {
    store.deliverables.value = [
      deliverable({
        id: 'd1',
        text: '<img src="assets/a.png" width="600" alt="arch">',
        title: 'One',
        titleSource: 'manual',
      }),
    ];
    const root = mount({ currentId: 'd1', assets: fakeStore([row('assets/a.png')]) });
    expect(keysIn(root, 'here')).toEqual(['assets/a.png']);
    expect(groupOf(root, 'unused')).toBe(null);
    act(() => {
      (groupOf(root, 'here')!.querySelector('[data-act="delete"]') as HTMLElement).click();
    });
    expect(root.querySelector('.fabry-arch-asset-confirm')!.textContent).toMatch(
      /Still referenced by One/,
    );
  });

  it('counts a reference-style image, whose href sits in a link definition', () => {
    store.deliverables.value = [
      deliverable({
        id: 'd1',
        text: '![arch][ref]\n\n[ref]: assets/a.png\n',
        title: 'One',
        titleSource: 'manual',
      }),
    ];
    const root = mount({ currentId: 'd1', assets: fakeStore([row('assets/a.png')]) });
    expect(keysIn(root, 'here')).toEqual(['assets/a.png']);
    expect(groupOf(root, 'unused')).toBe(null);
  });

  // W8: the reasons, not just the count. This is the action D6 makes mandatory and it has no other
  // channel — no log row, no per-file note — so three expired-token refusals reported themselves as
  // "3 of 3 could not be downloaded" and nothing else.
  it('names why a bulk download failed, not just how many', async () => {
    const assets = fakeStore(ROWS);
    const download = vi.fn(async (_s: any, key: string) =>
      key === 'assets/orphan.csv' ? 'orphan.csv: 500 Server Error' : 'a.png: 401 Unauthorized',
    );
    const root = mount({ currentId: 'd1', assets, download });
    await act(async () => {
      act$(root, 'download-all').click();
    });
    // One `await act()` flushes a microtask or two; the loop awaits each download in turn.
    await flush(() => /could not be downloaded/.test(noteText(root)));
    const note = noteText(root);
    expect(note).toMatch(/3 of 3 could not be downloaded/);
    expect(note).toMatch(/401 Unauthorized/);
    expect(note).toMatch(/500 Server Error/);
  });

  it('says why a reference could not be copied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('the document is not focused'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    await act(async () => {
      (groupOf(root, 'here')!.querySelector('[data-act="copy"]') as HTMLElement).click();
    });
    await flush(() => /could not be copied/.test(noteText(root)));
    expect(noteText(root)).toMatch(
      /assets\/a\.png could not be copied: the document is not focused/,
    );
  });

  it('says why even when the clipboard is not there to reject', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const root = mount({ currentId: 'd1', assets: fakeStore(ROWS) });
    await act(async () => {
      (groupOf(root, 'here')!.querySelector('[data-act="copy"]') as HTMLElement).click();
    });
    expect(noteText(root)).toMatch(/could not be copied: /);
  });

  // W9: a token that expires at file 12 of a 200-file folder import refused the other 188 one
  // round-trip at a time, with Retry disabled the whole way. Nothing was lost — every file got its
  // own named `failed` row — but there was no rule that said "the index is gone, stop".
  it('abandons the rest of a batch when the index dies mid-way, and says how many it skipped', async () => {
    const assets = fakeStore([]);
    let indexError: any = null;
    assets.stats = () => ({ bytes: 0, entries: 0, indexed: 0, indexError });
    assets.upload = vi.fn(async (f: File) => {
      if (f.name === 'f2.png') {
        indexError = 'Session expired.';
        throw new Error(
          'the file index could not be read (Session expired.); retry it, then upload',
        );
      }
      return { row: row('assets/' + f.name, { name: f.name }), reused: false };
    }) as any;
    const root = mount({ currentId: 'd1', assets });
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: Array.from({ length: 5 }, (_, i) => new File(['x'], `f${i}.png`)),
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change'));
    });
    await flush(() => /Stopped/.test(noteText(root)));
    expect(assets.upload).toHaveBeenCalledTimes(3);
    const note = noteText(root);
    expect(note).toMatch(/Stopped: Session expired\./);
    expect(note).toMatch(/2 files not attempted/);
    // The failure it stopped ON is still named in the log — stopping is not a way of going quiet.
    expect(root.querySelector('.fabry-arch-asset-log-row.state-failed')!.textContent).toMatch(
      /f2\.png/,
    );
  });

  // D2: a reference written before this feature existed resolves through an alias, so it must
  // count as a reference to the row it resolves to — not leave the file looking like an orphan.
  it('counts an aliased reference against the row it resolves to', () => {
    const aliased = row('assets/a.png', { aliases: ['https://example.test/old/a.png'] });
    store.deliverables.value = [
      deliverable({
        id: 'd1',
        text: '![a](https://example.test/old/a.png)',
        title: 'One',
        titleSource: 'manual',
      }),
    ];
    const root = mount({ currentId: 'd1', assets: fakeStore([aliased]) });
    expect(keysIn(root, 'here')).toEqual(['assets/a.png']);
    expect(groupOf(root, 'unused')).toBe(null);
  });
});
