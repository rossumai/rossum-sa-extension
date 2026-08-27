import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effect } from '@preact/signals';
import { createAssetStore } from '../src/fabry/architect/assets.js';

// The shape Data Storage hands back, which is NOT AssetRow: `_id` rather than `key`. Typing it
// here keeps the mock honest about which side of the boundary it stands on — mapping this into an
// AssetRow is itself part of what the read path is tested for.
type IndexDoc = {
  _id: string;
  kind: string;
  documentId: number;
  mime: string;
  name: string;
  size: number;
  sha256: string;
  aliases: string[];
};

const ROW = (key: string, size: number, id: number): IndexDoc => ({
  _id: key,
  kind: 'asset',
  documentId: id,
  mime: 'image/png',
  name: key.split('/').pop() as string,
  size,
  sha256: `sha-${id}`,
  aliases: [],
});

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

const store = (
  rows: IndexDoc[],
  fetchBytes: (documentId: number) => Promise<Blob>,
  maxBytes?: number,
) => createAssetStore({ find: async () => ({ result: rows }), fetchBytes, maxBytes });

describe('read path', () => {
  it('fetches once per key and caches the object URL', async () => {
    const fetchBytes = vi.fn(async () => new Blob(['x']));
    const s = store([ROW('assets/diagram.png', 10, 1234)], fetchBytes);
    await s.load();
    const a = await s.resolve('assets/diagram.png');
    const b = await s.resolve('assets/diagram.png');
    expect(a!.url).toBe(b!.url);
    expect(fetchBytes).toHaveBeenCalledOnce();
    expect(fetchBytes).toHaveBeenCalledWith(1234);
  });

  it('resolves an alias to the same row', async () => {
    const row = {
      ...ROW('assets/diagram.png', 10, 1234),
      aliases: ['https://example.test/old/diagram.png'],
    };
    const s = store([row], async () => new Blob(['x']));
    await s.load();
    expect(s.lookup('https://example.test/old/diagram.png')!.documentId).toBe(1234);
  });

  it('peek is synchronous — null before the fetch, the held value after', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => new Blob(['x']));
    await s.load();
    expect(s.peek('assets/diagram.png')).toBe(null);
    const held = await s.resolve('assets/diagram.png');
    expect(s.peek('assets/diagram.png#anchor')).toBe(held);
  });

  it('reports a failed fetch rather than throwing', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => {
      throw new Error('401');
    });
    await s.load();
    expect((await s.resolve('assets/diagram.png'))!.error).toBe('401');
  });

  it('evicts the OLDEST entry when a new one pushes past the budget', async () => {
    const s = store(
      [ROW('assets/a.png', 6, 1), ROW('assets/b.png', 5, 2)],
      async () => new Blob(['x']),
      10,
    );
    await s.load();
    const a = await s.resolve('assets/a.png');
    const b = await s.resolve('assets/b.png');
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(a!.url);
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalledWith(b!.url);
    expect(s.peek('assets/b.png')).toBe(b);
    expect(s.stats().bytes).toBe(5);
  });

  it('does not evict the entry it just inserted, even when it alone exceeds the budget', async () => {
    const s = store([ROW('assets/big.png', 99, 7)], async () => new Blob(['x']), 10);
    await s.load();
    const held = await s.resolve('assets/big.png');
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(s.peek('assets/big.png')).toBe(held);
    expect(s.stats().entries).toBe(1);
  });

  it('fetches once when the same key is resolved concurrently', async () => {
    const fetchBytes = vi.fn(async () => new Blob(['x']));
    const s = store([ROW('assets/diagram.png', 10, 1234)], fetchBytes);
    await s.load();
    const [x, y] = await Promise.all([
      s.resolve('assets/diagram.png'),
      s.resolve('assets/diagram.png'),
    ]);
    expect(fetchBytes).toHaveBeenCalledOnce();
    expect(x!.url).toBe(y!.url);
    expect(s.stats().bytes).toBe(10);
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('a second concurrent load waits for the index rather than seeing it empty', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => new Blob(['x']));
    await Promise.all([s.load(), s.load()]);
    expect(s.lookup('assets/diagram.png')).toBeTruthy();
  });

  it('methods still work when destructured off the store', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => new Blob(['x']));
    await s.load();
    const { resolve, peek } = s;
    const held = await resolve('assets/diagram.png');
    expect(held!.url).toBeTruthy();
    expect(peek('assets/diagram.png')).toBe(held);
  });

  it('survives an unreadable index without taking the pane down', async () => {
    const s = createAssetStore({
      find: async () => {
        throw new Error('nope');
      },
      // Never reached: the index read is what fails here.
      fetchBytes: async () => new Blob([]),
    });
    await s.load();
    expect(s.lookup('assets/diagram.png')).toBe(null);
    expect(s.stats().indexError).toBe('nope');
  });

  it('surfaces a failed fetch to peek as unavailable, and bumps the version', async () => {
    const s = store([ROW('assets/diagram.png', 10, 1234)], async () => {
      throw new Error('401');
    });
    await s.load();
    const before = s.version();
    expect(await s.resolve('assets/diagram.png')).toMatchObject({ error: '401' });
    expect(s.peek('assets/diagram.png')).toMatchObject({ error: '401' });
    expect(s.version()).not.toBe(before);
    expect(s.stats().bytes).toBe(0);
  });

  it('retries a previously failed fetch rather than serving the failure forever', async () => {
    let attempt = 0;
    const fetchBytes = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('401');
      return new Blob(['x']);
    });
    const s = store([ROW('assets/diagram.png', 10, 1234)], fetchBytes);
    await s.load();
    await s.resolve('assets/diagram.png');
    const second = await s.resolve('assets/diagram.png');
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(second!.url).toBeTruthy();
    expect(second!.error).toBeUndefined();
    expect(s.peek('assets/diagram.png')).toBe(second);
  });

  // A 401 on an expired token, or a request dropped at boot, must not be permanent for the
  // session: memoising the failed read left the panel showing that error and every asset in the
  // document unresolvable until the whole Console was reloaded.
  it('retries the index after a failed read, and clears the error when one succeeds', async () => {
    let attempt = 0;
    const find = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('401');
      return { result: [ROW('assets/diagram.png', 10, 1234)] };
    });
    const s = createAssetStore({ find, fetchBytes: async () => new Blob(['x']) });
    await s.load();
    expect(s.stats().indexError).toBe('401');
    expect(s.lookup('assets/diagram.png')).toBe(null);

    await s.load();
    expect(find).toHaveBeenCalledTimes(2);
    expect(s.stats().indexError).toBe(null);
    expect(s.lookup('assets/diagram.png')).toBeTruthy();
  });

  it('still memoises a SUCCESSFUL read, so a repaint costs no request', async () => {
    const find = vi.fn(async () => ({ result: [ROW('assets/diagram.png', 10, 1234)] }));
    const s = createAssetStore({ find, fetchBytes: async () => new Blob(['x']) });
    await s.load();
    await s.load();
    await s.load();
    expect(find).toHaveBeenCalledOnce();
  });

  // R6: the read swallows its OWN failure into `indexError`, but the recovery above must not
  // depend on it never throwing for another reason. `version()` is a signal, and signals notify
  // subscribers synchronously, so a subscriber that throws rejects the read — and a rejected
  // promise memoised in `loading` takes the retry with it. Nobody awaits load(), so it would
  // surface only as an unhandled rejection.
  it('recovers when the read throws outside its own error handling', async () => {
    const find = vi.fn(async () => ({ result: [ROW('assets/diagram.png', 10, 1234)] }));
    const s = createAssetStore({ find, fetchBytes: async () => new Blob(['x']) });
    let armed = false;
    const stop = effect(() => {
      s.version();
      if (armed) {
        armed = false;
        throw new Error('a subscriber threw');
      }
    });
    armed = true;
    try {
      await s.load();
      expect(s.stats().indexError).toBe('a subscriber threw');
      await s.load();
      expect(find).toHaveBeenCalledTimes(2);
      expect(s.stats().indexError).toBe(null);
      expect(s.lookup('assets/diagram.png')).toBeTruthy();
    } finally {
      stop();
    }
  });
});

// R7: `resolve` runs OFF the write chain — it is a read path, and the pinning design depends on
// that — so a delete can land while its bytes are still in flight.
describe('a row deleted while its bytes are in flight', () => {
  const heldStore = (fetchBytes: () => Promise<Blob>) =>
    createAssetStore({
      find: async () => ({ result: [ROW('assets/diagram.png', 10, 1234)] }),
      fetchBytes,
      deleteDocument: async () => {},
      deleteRow: async () => {},
    });

  it('is not cached, and its bytes are not charged to a budget nothing can free', async () => {
    let release: (() => void) | null = null;
    const s = heldStore(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return new Blob(['x']);
    });
    await s.load();
    const pending = s.resolve('assets/diagram.png');
    await new Promise((r) => setTimeout(r, 0));
    await s.remove('assets/diagram.png');
    release!();
    const held = await pending;

    expect(held!.url).toBeUndefined();
    expect(held!.error).toMatch(/deleted/);
    // Cached, it would be unreachable through `lookup` — so never used, never freed, and its
    // size subtracted from the eviction budget for the rest of the session.
    expect(s.stats().bytes).toBe(0);
    expect(s.stats().entries).toBe(0);
    expect(s.peek('assets/diagram.png')).toBe(null);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
