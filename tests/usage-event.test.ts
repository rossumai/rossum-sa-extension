import { describe, it, expect } from 'vitest';
import { EVENT_NAMES, buildPayload } from '../src/usage/event.js';

const base = { clientId: 'c1', sessionId: 's1', version: 'abc1234' };

describe('usage event vocabulary', () => {
  it('every name satisfies GA4 naming rules', () => {
    for (const n of EVENT_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });

  it('has no duplicate names', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });

  it('carries exactly the 44 names PRIVACY.md publishes', () => {
    expect(EVENT_NAMES).toHaveLength(44);
  });

  it('no longer reports configuration changes, only use', () => {
    for (const gone of ['sa_config_snapshot', 'sa_popup_toggle_on', 'sa_popup_toggle_off']) {
      expect(EVENT_NAMES).not.toContain(gone);
    }
  });
});

describe('buildPayload', () => {
  it('builds the MP body with the mandatory params', () => {
    const body = buildPayload({ ...base, name: 'sa_popup_open' });
    expect(body.client_id).toBe('c1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe('sa_popup_open');
    expect(body.events[0].params).toEqual({
      ext_ver: 'abc1234',
      session_id: 's1',
      engagement_time_msec: 1,
    });
  });

  it('rejects an event name outside the vocabulary', () => {
    expect(() => buildPayload({ ...base, name: 'sa_made_up' })).toThrow(/unknown event/);
  });

  it('ignores any params a caller passes — there is no field for them', () => {
    const body = buildPayload({
      // `params` is deliberately supplied: the assertion is that buildPayload drops it.
      ...(base as any),
      name: 'sa_popup_open',
      params: { org: 'acme', page_location: 'https://x' },
    });
    expect(body.events[0].params).toEqual({
      ext_ver: 'abc1234',
      session_id: 's1',
      engagement_time_msec: 1,
    });
  });

  it('rejects a missing client id', () => {
    expect(() => buildPayload({ ...base, clientId: '', name: 'sa_popup_open' })).toThrow(
      /clientId/,
    );
  });

  it('omits an unusable version rather than dropping the whole event', () => {
    // A throw here would lose a real feature-use event over a cosmetic field.
    const body = buildPayload({ ...base, version: 'v'.repeat(101), name: 'sa_popup_open' });
    expect(body.events[0].params).toEqual({ session_id: 's1', engagement_time_msec: 1 });
  });
});
