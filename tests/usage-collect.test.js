import { describe, it, expect } from 'vitest';
import { collect } from '../src/usage/collect.js';

function makeDeps(local = {}, session = {}) {
  const sent = [];
  const deps = {
    sent,
    local,
    session,
    getLocal: (keys) => {
      const out = {};
      for (const k of keys) if (k in local) out[k] = local[k];
      return Promise.resolve(out);
    },
    setLocal: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
    removeLocal: (keys) => { for (const k of keys) delete local[k]; return Promise.resolve(); },
    getSession: (keys) => {
      const out = {};
      for (const k of keys) if (k in session) out[k] = session[k];
      return Promise.resolve(out);
    },
    setSession: (obj) => { Object.assign(session, obj); return Promise.resolve(); },
    uuid: () => 'uuid-1',
    today: () => '2026-08-03',
    version: () => 'abc1234',
    endpoint: () => 'https://ga/collect',
    fetch: (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ status: 204 });
    },
  };
  return deps;
}

describe('consent gate', () => {
  it('sends nothing when consent was never given', async () => {
    const d = makeDeps({});
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(0);
    expect(d.sent).toEqual([]);
    expect(d.local.usageClientId).toBeUndefined();
  });

  it('sends nothing when consent is false or a truthy non-true value', async () => {
    for (const value of [false, 'true', 1]) {
      const d = makeDeps({ usageConsent: value, usageClientId: 'c1' });
      expect(await collect({ name: 'sa_popup_open' }, d)).toBe(0);
      expect(d.sent).toEqual([]);
    }
  });

  it('sends nothing when consent was never given, even with an id present', async () => {
    const d = makeDeps({ usageClientId: 'leftover' });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(0);
    expect(d.sent).toEqual([]);
  });

  it('drops an event name outside the vocabulary', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    expect(await collect({ name: 'sa_evil' }, d)).toBe(0);
    expect(d.sent).toEqual([]);
  });

  it('drops an event carrying a non-allowlisted param instead of throwing', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    await expect(collect({ name: 'sa_popup_open', params: { org: 'acme' } }, d)).resolves.toBe(0);
    expect(d.sent).toEqual([]);
  });
});

describe('sending', () => {
  it('sends the event and creates a session id', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].url).toBe('https://ga/collect');
    expect(d.sent[0].body.events[0].name).toBe('sa_popup_open');
    expect(d.session.usageSessionId).toBe('uuid-1');
  });

  it('emits the config snapshot once per UTC day, piggybacked on the first event', async () => {
    const d = makeDeps({
      usageConsent: true, usageClientId: 'c1', schemaAnnotationsEnabled: true,
    });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(2);
    expect(d.sent.map((s) => s.body.events[0].name))
      .toEqual(['sa_config_snapshot', 'sa_popup_open']);
    expect(d.sent[0].body.events[0].params.schema_ids).toBe(1);
    expect(d.local.usageSnapshotDay).toBe('2026-08-03');

    d.sent.length = 0;
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.sent.map((s) => s.body.events[0].name)).toEqual(['sa_popup_open']);
  });

  it('never rejects when the network fails', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    d.fetch = () => Promise.reject(new Error('offline'));
    await expect(collect({ name: 'sa_popup_open' }, d)).resolves.toBe(0);
  });
});

describe('a failing daily snapshot must not take the real event down with it', () => {
  it('still sends the triggering event, and does not burn the day marker', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1' });
    let n = 0;
    d.fetch = (url, init) => {
      n += 1;
      // First POST of the day is the snapshot; fail only that one.
      if (n === 1) return Promise.reject(new Error('offline'));
      d.sent.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ status: 204 });
    };
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.sent.map((s) => s.body.events[0].name)).toEqual(['sa_popup_open']);
    // Unmarked, so the snapshot is retried on a later event instead of lost.
    expect(d.local.usageSnapshotDay).toBeUndefined();
  });
});

describe('concurrent events are serialized', () => {
  it('mints one client id and one daily snapshot for a burst', async () => {
    const d = makeDeps({ usageConsent: true });
    let seq = 0;
    d.uuid = () => `uuid-${(seq += 1)}`;
    await Promise.all([
      collect({ name: 'sa_popup_open' }, d),
      collect({ name: 'sa_rossum_schema_ids' }, d),
      collect({ name: 'sa_console_open' }, d),
    ]);
    const names = d.sent.map((s) => s.body.events[0].name);
    expect(names.filter((x) => x === 'sa_config_snapshot')).toHaveLength(1);
    const ids = new Set(d.sent.map((s) => s.body.client_id));
    expect(ids.size).toBe(1);
  });
});

describe('client id is minted lazily by the worker', () => {
  // Nothing durable may depend on a message reaching this worker: the popup that
  // granted consent can be destroyed first. So the id is created at first use.
  it('mints and stores an id when consent is on but none exists yet', async () => {
    const d = makeDeps({ usageConsent: true, usageSnapshotDay: '2026-08-03' });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.local.usageClientId).toBe('uuid-1');
    expect(d.sent[0].body.client_id).toBe('uuid-1');
  });

  it('reuses an existing id rather than minting a second one', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'existing', usageSnapshotDay: '2026-08-03' });
    await collect({ name: 'sa_popup_open' }, d);
    expect(d.local.usageClientId).toBe('existing');
    expect(d.sent[0].body.client_id).toBe('existing');
  });

  it('mints nothing when consent is absent', async () => {
    const d = makeDeps({});
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(0);
    expect(d.local.usageClientId).toBeUndefined();
  });
});
