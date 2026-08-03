import { describe, it, expect } from 'vitest';
import {
  EVENT_NAMES, SNAPSHOT_KEYS, buildPayload, buildSnapshotParams,
} from '../src/usage/event.js';

const base = { clientId: 'c1', sessionId: 's1', version: 'abc1234' };

describe('usage event vocabulary', () => {
  it('every name satisfies GA4 naming rules', () => {
    for (const n of EVENT_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });

  it('has no duplicate names', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});

describe('buildPayload', () => {
  it('builds the MP body with the mandatory params', () => {
    const body = buildPayload({ ...base, name: 'sa_popup_open' });
    expect(body.client_id).toBe('c1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe('sa_popup_open');
    expect(body.events[0].params).toEqual({
      ext_ver: 'abc1234', session_id: 's1', engagement_time_msec: 1,
    });
  });

  it('rejects an event name outside the vocabulary', () => {
    expect(() => buildPayload({ ...base, name: 'sa_made_up' })).toThrow(/unknown event/);
  });

  it('rejects a param key that is not allowlisted — the leak guard', () => {
    expect(() => buildPayload({ ...base, name: 'sa_popup_open', params: { org: 'acme' } }))
      .toThrow(/not allowed/);
    expect(() => buildPayload({ ...base, name: 'sa_popup_open', params: { page_location: 'https://x' } }))
      .toThrow(/not allowed/);
  });

  it('rejects Object.prototype keys — they must not resolve to inherited validators', () => {
    // Plain bracket access made `constructor` resolve to Object.prototype's
    // function, which is truthy and was then called as the validator, waving the
    // param through. Verified as a real bypass before the hasOwnProperty guard.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(() => buildPayload({ ...base, name: 'sa_popup_open', params: { [key]: 'LEAKED' } }))
        .toThrow(/param not allowed/);
    }
  });

  it('rejects a feature value outside the toggle enum', () => {
    expect(() => buildPayload({ ...base, name: 'sa_popup_toggle_on', params: { feature: 'whatever' } }))
      .toThrow(/not allowed/);
    expect(buildPayload({ ...base, name: 'sa_popup_toggle_on', params: { feature: 'scrollLockEnabled' } })
      .events[0].params.feature).toBe('scrollLockEnabled');
  });

  it('rejects a missing client id and an over-long version', () => {
    expect(() => buildPayload({ ...base, clientId: '', name: 'sa_popup_open' })).toThrow(/clientId/);
    expect(() => buildPayload({ ...base, version: 'v'.repeat(101), name: 'sa_popup_open' }))
      .toThrow(/not allowed/);
  });

  it('maps stored toggles to 0/1 snapshot params', () => {
    const params = buildSnapshotParams({ schemaAnnotationsEnabled: true, experimentalUnlocked: 1 });
    expect(params.schema_ids).toBe(1);
    expect(params.experimental).toBe(1);
    expect(params.resource_ids).toBe(0);
    expect(Object.keys(params).sort()).toEqual(Object.keys(SNAPSHOT_KEYS).sort());
  });

  it('accepts the snapshot event with all eight booleans', () => {
    const body = buildPayload({
      ...base, name: 'sa_config_snapshot', params: buildSnapshotParams({}),
    });
    expect(Object.keys(body.events[0].params).length).toBe(11);
  });
});
