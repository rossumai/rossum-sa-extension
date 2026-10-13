// tests/popup-mdh-revalidate.test.tsx
// @vitest-environment jsdom
// Spec 2026-10-13-api-call-reduction-design.md §4.4: what a warm popup open sends.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import MdhProvenancePanel from '../src/popup/components/MdhProvenancePanel.jsx';

const DOMAIN = 'https://org.rossum.app';
const TAB = { id: 1, windowId: 7, index: 0, url: `${DOMAIN}/document/5` };
const SCHEMA_URL = `${DOMAIN}/api/v1/schemas/9`;
const OTHER_HOOK = { id: 60, name: 'Other', type: 'function', active: true };
const mdhHook = (queueIds?: number[]) => ({
  id: 50,
  name: 'MDH',
  type: 'webhook',
  active: true,
  settings: {
    configurations: [
      {
        name: 'Vendor',
        ...(queueIds ? { queue_ids: queueIds } : {}),
        source: { dataset: 'vendors', queries: [{ find: { name: '{sender_name}' } }] },
        mapping: { target_schema_id: 'vendor_code', dataset_key: 'code' },
      },
    ],
  },
});
const throttled = (retryAfter: string | null) => ({
  ok: false,
  status: 429,
  headers: { get: (n: string) => (n === 'Retry-After' ? retryAfter : null) },
  json: async () => ({}),
});

let root: HTMLDivElement;
let session: Record<string, any>;
let urls: string[];
let hooksList: any[];
let attached: string[];
let route: (url: string) => any; // per-test override, checked first
let annQueue: number;
let annModified: string;
let schemaModified: string;

async function waitFor(cond: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const message = () => root.querySelector('.mdh-empty')?.textContent;
const count = (part: string) => urls.filter((u) => u.includes(part)).length;
async function open() {
  render(null, root);
  render(<MdhProvenancePanel tab={TAB} />, root);
  await waitFor(() => !!message() && message() !== 'Loading…');
}

beforeEach(() => {
  session = {};
  urls = [];
  hooksList = [OTHER_HOOK];
  attached = ['60'];
  route = () => undefined;
  annQueue = 42;
  annModified = 'm1';
  schemaModified = 's1';
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('chrome', {
    scripting: {
      // No queue in the URL: the panel resolves it from the annotation.
      executeScript: vi.fn(async () => [
        { result: { token: 'tok', domain: DOMAIN, annotationId: '5', queueId: null } },
      ]),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn((_o: any, cb?: any) => cb?.()) },
      session: {
        get: vi.fn(async (k: string) => (k in session ? { [k]: session[k] } : {})),
        set: vi.fn(async (o: any) => {
          Object.assign(session, o);
        }),
        remove: vi.fn(async (k: string) => {
          delete session[k];
        }),
      },
    },
    tabs: { create: vi.fn() },
    runtime: { sendMessage: vi.fn(), getURL: (p: string) => `chrome-extension://x/${p}` },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const special = route(url);
      if (special) return special;
      const body = (() => {
        if (url.includes('/annotations/5?fields=url,queue,modified_at'))
          return { queue: `${DOMAIN}/api/v1/queues/${annQueue}`, modified_at: annModified };
        if (url.includes('/annotations/5?fields=queue'))
          return { queue: `${DOMAIN}/api/v1/queues/${annQueue}` };
        if (url.includes('/annotations/5?fields=modified_at')) return { modified_at: annModified };
        if (url.includes('/annotations/5/content')) return { content: [] };
        if (url.includes('/api/v1/hooks?')) return { results: hooksList };
        if (url.includes('/queues/42?fields=hooks'))
          return { hooks: attached.map((id) => `${DOMAIN}/api/v1/hooks/${id}`) };
        if (url.includes('/queues/42?fields=schema')) return { schema: SCHEMA_URL };
        if (url.includes('/schemas?queue=42'))
          return { results: [{ id: 9, modified_at: schemaModified }] };
        if (url.startsWith(SCHEMA_URL)) return { id: 9, modified_at: schemaModified, content: [] };
        return {};
      })();
      return { ok: true, status: 200, json: async () => body };
    }),
  );
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('MDH card — queue with no MDH hook', () => {
  it('second open is served from cache; only the small checks go out', async () => {
    await open();
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(1);
    urls = [];
    await open();
    await waitFor(() => count('/queues/42?fields=hooks') === 1);
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(0);
    expect(count('/annotations/5?fields=url,queue,modified_at')).toBe(0);
    expect(count('/annotations/5?fields=queue')).toBe(1);
  });

  it('Refresh bypasses the caches and refetches the hooks list and the schema', async () => {
    await open();
    await open();
    urls = [];
    const btn = root.querySelector<HTMLButtonElement>('button.mdh-refresh-btn[title^="Refresh"]')!;
    btn.click();
    await waitFor(() => count('/api/v1/hooks?') >= 1 && count('?fields=schema') >= 1);
  });

  it('an edit to the annotation that keeps its queue refetches nothing', async () => {
    await open();
    urls = [];
    annModified = 'm2';
    await open();
    await waitFor(() => count('/annotations/5?fields=queue') === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(0);
    expect(count('?fields=schema')).toBe(0);
  });

  it('an annotation moved to another queue triggers the full fetch', async () => {
    await open();
    urls = [];
    annQueue = 43;
    render(null, root);
    render(<MdhProvenancePanel tab={TAB} />, root);
    await waitFor(() => count('/annotations/5?fields=url,queue,modified_at') === 1);
  });

  it('a newly attached hook triggers the full fetch', async () => {
    await open();
    urls = [];
    hooksList = [OTHER_HOOK, mdhHook()];
    attached = ['60', '50'];
    // Not open(): the cached message is replaced by the loaded cards within a tick, so
    // waiting for the message would race the refetch.
    render(null, root);
    render(<MdhProvenancePanel tab={TAB} />, root);
    await waitFor(() => count('/api/v1/hooks?') === 1);
  });

  it('a failed background check keeps the view and fetches nothing more', async () => {
    await open();
    urls = [];
    route = (url) => (url.includes('/queues/42?fields=hooks') ? throttled(null) : undefined);
    await open();
    await waitFor(() => count('/queues/42?fields=hooks') === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(0);
  });
});

describe('MDH card — hooks attached but none applies', () => {
  it('keeps the message and skips the attachment check inside the window', async () => {
    hooksList = [mdhHook([999])];
    attached = ['50'];
    await open();
    expect(message()).toBe('No MDH configurations apply to this queue.');
    urls = [];
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(message()).toBe('No MDH configurations apply to this queue.');
    expect(count('/queues/42?fields=hooks')).toBe(0);
    expect(count('/api/v1/hooks?')).toBe(0);
  });
});

describe('MDH card — schema past its window', () => {
  it('confirms the signature with the schemas list instead of refetching the schema', async () => {
    await open();
    const key = `mdhProv:schema:v2:${DOMAIN}#42`;
    expect(session[key].sig).toBe('9:s1');
    const old = Date.now() - 6 * 60 * 1000;
    session[key].fetchedAt = old;
    urls = [];
    await open();
    await waitFor(() => count('/schemas?queue=42') === 1);
    await waitFor(() => session[key].fetchedAt > old); // the window restarts
    expect(count('/queues/42?fields=schema')).toBe(0);
    expect(count('/schemas/9')).toBe(0);
  });
});

describe('MDH card — schema signature unknown', () => {
  it('an empty schemas list is not a change: no schema refetch, and the window does not restart', async () => {
    await open();
    const key = `mdhProv:schema:v2:${DOMAIN}#42`;
    const old = Date.now() - 6 * 60 * 1000;
    session[key].fetchedAt = old;
    urls = [];
    route = (url) =>
      url.includes('/schemas?queue=42')
        ? { ok: true, status: 200, json: async () => ({ results: [] }) }
        : undefined;
    await open();
    await waitFor(() => count('/schemas?queue=42') === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(count('/schemas/9')).toBe(0);
    expect(count('/api/v1/hooks?')).toBe(0);
    expect(session[key].fetchedAt).toBe(old);
  });
});

describe('MDH card — one background check fails', () => {
  it('a throttled schema check does not discard the annotation check that saw a change', async () => {
    await open();
    const key = `mdhProv:schema:v2:${DOMAIN}#42`;
    session[key].fetchedAt = Date.now() - 6 * 60 * 1000;
    urls = [];
    annQueue = 43; // the annotation moved: its check reports a change
    route = (url) => (url.includes('/schemas?queue=42') ? throttled(null) : undefined);
    render(null, root);
    render(<MdhProvenancePanel tab={TAB} />, root);
    await waitFor(() => count('/schemas?queue=42') === 1);
    await waitFor(() => count('/annotations/5?fields=url,queue,modified_at') === 1);
  });
});

describe('MDH card — schema signature changed', () => {
  it('fetches the schema again when the schemas list reports a new modified_at', async () => {
    await open();
    const key = `mdhProv:schema:v2:${DOMAIN}#42`;
    session[key].fetchedAt = Date.now() - 6 * 60 * 1000;
    urls = [];
    schemaModified = 's2';
    render(null, root);
    render(<MdhProvenancePanel tab={TAB} />, root);
    await waitFor(() => count('/schemas?queue=42') === 1);
    await waitFor(() => count('/schemas/9') === 1);
  });
});

describe('MDH card — 429', () => {
  it('shows the rate-limit message for a throttled hooks list', async () => {
    route = (url) => (url.includes('/api/v1/hooks?') ? throttled('3') : undefined);
    await open();
    expect(message()).toBe('Rossum is rate-limiting requests. Try again in 3 s.');
  });

  it('a throttled schema load is not "No MDH matching"', async () => {
    route = (url) => (url.startsWith(SCHEMA_URL) ? throttled(null) : undefined);
    await open();
    expect(message()).toBe('Rossum is rate-limiting requests. Try again shortly.');
  });

  it('a throttled values load is shown, not cached as empty values', async () => {
    hooksList = [mdhHook()];
    attached = ['50'];
    route = (url) => (url.includes('/annotations/5/content') ? throttled(null) : undefined);
    await open();
    expect(message()).toBe('Rossum is rate-limiting requests. Try again shortly.');
    expect(Object.keys(session).some((k) => k.startsWith('mdhProv:ann:'))).toBe(false);
  });
});
