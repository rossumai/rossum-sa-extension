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
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1' });
    expect(await collect({ name: 'sa_evil' }, d)).toBe(0);
    expect(d.sent).toEqual([]);
  });

});

describe('sending', () => {
  it('sends the event and creates a session id', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1' });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].url).toBe('https://ga/collect');
    expect(d.sent[0].body.events[0].name).toBe('sa_popup_open');
    expect(d.session.usageSessionId).toBe('uuid-1');
  });

  it('ignores stray params on the message — an old surface cannot leak through', async () => {
    // After an upgrade an orphaned content script can still post the old message
    // shape. The params must be dropped, not forwarded, and not fatal.
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1' });
    expect(await collect({ name: 'sa_popup_open', params: { org: 'acme' } }, d)).toBe(1);
    expect(d.sent[0].body.events[0].params).toEqual({
      ext_ver: 'abc1234', session_id: 'uuid-1', engagement_time_msec: 1,
    });
  });

  it('never rejects when the network fails', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1' });
    d.fetch = () => Promise.reject(new Error('offline'));
    await expect(collect({ name: 'sa_popup_open' }, d)).resolves.toBe(0);
  });
});

describe('concurrent events are serialized', () => {
  it('mints exactly one client id for a burst', async () => {
    const d = makeDeps({ usageConsent: true });
    let seq = 0;
    d.uuid = () => `uuid-${(seq += 1)}`;
    await Promise.all([
      collect({ name: 'sa_popup_open' }, d),
      collect({ name: 'sa_rossum_schema_ids' }, d),
      collect({ name: 'sa_console_open' }, d),
    ]);
    expect(d.sent).toHaveLength(3);
    const ids = new Set(d.sent.map((s) => s.body.client_id));
    expect(ids.size).toBe(1);
    expect(d.local.usageClientId).toBe('uuid-1');
  });
});

describe('client id is minted lazily by the worker', () => {
  // Nothing durable may depend on a message reaching this worker: the popup that
  // granted consent can be destroyed first. So the id is created at first use.
  it('mints and stores an id when consent is on but none exists yet', async () => {
    const d = makeDeps({ usageConsent: true });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.local.usageClientId).toBe('uuid-1');
    expect(d.sent[0].body.client_id).toBe('uuid-1');
  });

  it('reuses an existing id rather than minting a second one', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'existing' });
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
