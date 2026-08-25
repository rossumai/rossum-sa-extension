import { describe, it, expect, beforeEach, vi } from 'vitest';

function stubRuntime() {
  const sent: any = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg: any) => {
        sent.push(msg);
        return Promise.resolve();
      },
    },
  } as any;
  return sent;
}

// track.js keeps a module-level "already sent" set, so each test needs a fresh
// module instance rather than a reset helper exported for tests only.
async function freshTrack() {
  vi.resetModules();
  return import('../src/usage/track.js');
}

describe('track', () => {
  let sent: any;
  beforeEach(() => {
    sent = stubRuntime();
  });

  it('posts the message shape the worker expects', async () => {
    const { track } = await freshTrack();
    track('sa_popup_open');
    expect(sent).toEqual([{ type: 'sa-usage', name: 'sa_popup_open' }]);
  });

  it('never puts params on the message, even when a caller passes one', async () => {
    const { track } = await freshTrack();
    // Deliberately mis-called: the point of the test is that a second argument cannot
    // reach the message. `track` takes one parameter, so the cast is what lets a JS
    // caller's mistake be reproduced here.
    (track as any)('sa_popup_open', { feature: 'scrollLockEnabled' });
    expect(sent).toEqual([{ type: 'sa-usage', name: 'sa_popup_open' }]);
  });

  it('returns undefined and never throws when messaging is unavailable', async () => {
    const { track } = await freshTrack();
    globalThis.chrome = {} as any;
    expect(track('sa_popup_open')).toBeUndefined();
  });

  it('swallows a rejected sendMessage promise', async () => {
    const { track } = await freshTrack();
    globalThis.chrome = {
      runtime: { sendMessage: () => Promise.reject(new Error('no receiver')) },
    } as any;
    expect(() => track('sa_popup_open')).not.toThrow();
    await Promise.resolve();
  });
});

describe('consent short-circuit', () => {
  // The worker stays the authority; this only avoids waking it needlessly.
  function stub({ stored, hang = false }: { stored?: any; hang?: boolean } = {}) {
    const sent: any = [];
    let onChanged: any = null;
    globalThis.chrome = {
      runtime: {
        sendMessage: (m: any) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      storage: {
        local: { get: () => (hang ? new Promise(() => {}) : Promise.resolve(stored || {})) },
        onChanged: {
          addListener: (fn: any) => {
            onChanged = fn;
          },
        },
      } as any,
    } as any;
    return { sent, fire: (v: any) => onChanged({ usageConsent: { newValue: v } }, 'local') };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('does not wake the worker when consent was never given', async () => {
    const s = stub({ stored: {} });
    const { track } = await freshTrack();
    await flush();
    track('sa_popup_open');
    expect(s.sent).toEqual([]);
  });

  it('sends when consent is stored as true', async () => {
    const s = stub({ stored: { usageConsent: true } });
    const { track } = await freshTrack();
    await flush();
    track('sa_popup_open');
    expect(s.sent).toHaveLength(1);
  });

  it('fails OPEN while consent is still unknown, so first events are not lost', async () => {
    const s = stub({ hang: true });
    const { track } = await freshTrack();
    track('sa_popup_open');
    expect(s.sent).toHaveLength(1);
  });

  it('follows live consent changes in both directions', async () => {
    const s = stub({ stored: { usageConsent: true } });
    const { track } = await freshTrack();
    await flush();

    s.fire(false);
    track('sa_popup_open');
    expect(s.sent).toHaveLength(0);

    s.fire(true);
    track('sa_popup_open');
    expect(s.sent).toHaveLength(1);
  });
});

describe('trackOnce', () => {
  let sent: any;
  beforeEach(() => {
    sent = stubRuntime();
  });

  it('sends the first call and swallows every repeat in this page lifetime', async () => {
    const { trackOnce } = await freshTrack();
    for (let i = 0; i < 300; i += 1) trackOnce('sa_rossum_schema_ids');
    expect(sent).toHaveLength(1);
  });

  it('tracks each name independently', async () => {
    const { trackOnce } = await freshTrack();
    trackOnce('sa_rossum_schema_ids');
    trackOnce('sa_rossum_resource_ids');
    trackOnce('sa_rossum_schema_ids');
    expect(sent.map((m: any) => m.name)).toEqual([
      'sa_rossum_schema_ids',
      'sa_rossum_resource_ids',
    ]);
  });
});
