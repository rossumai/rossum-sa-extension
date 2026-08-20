import { describe, it, expect, vi } from 'vitest';
import {
  CHECKS, evaluateVisit, evaluateApi, signatureFor, collectResponses,
} from '../src/training/steps.js';

const loc = (pathname, search = '') => ({ pathname, search });

describe('evaluateVisit', () => {
  it('matches a detail route by type', () => {
    expect(evaluateVisit({ target: { type: 'queue', detail: true } }, loc('/queues/42'))).toBe(true);
    expect(evaluateVisit({ target: { type: 'hook', detail: true } }, loc('/queues/42'))).toBe(false);
  });

  it('distinguishes a list route from a detail route of the same type', () => {
    const list = loc('/extensions/my-extensions');
    const detail = loc('/extensions/my-extensions/9');
    expect(evaluateVisit({ target: { type: 'hook', detail: false } }, list)).toBe(true);
    expect(evaluateVisit({ target: { type: 'hook', detail: false } }, detail)).toBe(false);
    expect(evaluateVisit({ target: { type: 'hook', detail: true } }, detail)).toBe(true);
  });

  it('matches the organization dashboard', () => {
    const l = loc('/documents', '?level=all');
    expect(evaluateVisit({ target: { type: 'organization' } }, l)).toBe(true);
  });

  it('returns false when no resource is detected', () => {
    expect(evaluateVisit({ target: { type: 'queue', detail: true } }, loc('/nowhere'))).toBe(false);
  });
});

describe('CHECKS', () => {
  it('every check declares an id, paths and both functions', () => {
    for (const id of Object.keys(CHECKS)) {
      const c = CHECKS[id];
      expect(c.id).toBe(id);
      expect(Array.isArray(c.paths)).toBe(true);
      expect(c.paths.length).toBeGreaterThan(0);
      expect(typeof c.signature).toBe('function');
      expect(typeof c.pass).toBe('function');
    }
  });

  it('hookAttachedToQueue passes only when a new hook:queue pair appears', () => {
    const hooks = CHECKS.hookAttachedToQueue.paths[0];
    const before = { [hooks]: { results: [
      { url: '/api/v1/hooks/7', queues: [] }] } };
    const after = { [hooks]: { results: [
      { url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }] } };
    const base = signatureFor('hookAttachedToQueue', before);
    expect(evaluateApi(CHECKS.hookAttachedToQueue, signatureFor('hookAttachedToQueue', before), base)).toBe(false);
    expect(evaluateApi(CHECKS.hookAttachedToQueue, signatureFor('hookAttachedToQueue', after), base)).toBe(true);
  });

  it('thresholdChanged passes only when a known queue threshold moves', () => {
    const p = CHECKS.thresholdChanged.paths[0];
    const base = signatureFor('thresholdChanged', { [p]: { results: [
      { url: '/api/v1/queues/4', default_score_threshold: 0.8 }] } });
    const same = signatureFor('thresholdChanged', { [p]: { results: [
      { url: '/api/v1/queues/4', default_score_threshold: 0.8 }] } });
    const moved = signatureFor('thresholdChanged', { [p]: { results: [
      { url: '/api/v1/queues/4', default_score_threshold: 0.95 }] } });
    expect(evaluateApi(CHECKS.thresholdChanged, same, base)).toBe(false);
    expect(evaluateApi(CHECKS.thresholdChanged, moved, base)).toBe(true);
  });

  it('never passes when the baseline is missing', () => {
    const p = CHECKS.ruleCreated.paths[0];
    const now = signatureFor('ruleCreated', { [p]: { results: [{ id: 1 }] } });
    expect(evaluateApi(CHECKS.ruleCreated, now, null)).toBe(false);
  });

  it('no check is left referenced by nothing — every CHECKS id is used by a step', async () => {
    const { TRACK } = await import('../src/training/track.js');
    const referenced = new Set(TRACK.missions
      .flatMap((m) => m.steps).filter((s) => s.kind === 'api').map((s) => s.check));
    expect([...Object.keys(CHECKS)].sort()).toEqual([...referenced].sort());
  });
});

// I4. Rossum list endpoints order by id ASCENDING by default, so on an org past
// one page the thing the trainee just created is on the LAST page. The org this
// track was verified against holds 96 rules and 133 schemas.
describe('paging strategy', () => {
  it('every /api/v1/ check reads EVERY page', () => {
    for (const id of ['ruleCreated', 'hookAttachedToQueue', 'thresholdChanged', 'schemaFieldAdded']) {
      expect(CHECKS[id].paginate, `${id} must paginate`).toBe(true);
    }
  });

  // `ordering=-id` was tried and REVERTED: it is unverified (DRF silently
  // ignores an unexposed ordering field, so a wrong guess breaks the delta with
  // no error), and for thresholdChanged it is actively worse than the ascending
  // default — see the test below.
  it('no check relies on an ordering query parameter', () => {
    for (const id of Object.keys(CHECKS)) {
      for (const p of CHECKS[id].paths) expect(p).not.toContain('ordering');
    }
  });

  // The regression `ordering=-id` introduced. thresholdChanged's own teaching
  // text says "on a queue that already existed", and `changed()` only fires for
  // a key in BOTH snapshots — so the queues newest-first drops are exactly the
  // ones the step points the trainee at.
  it('thresholdChanged still sees an OLD queue that is past page 1', async () => {
    const check = CHECKS.thresholdChanged;
    const first = check.paths[0];
    const page = (queues, next) => ({ pagination: { next }, results: queues });
    // Queue 4 is the oldest — it sorts to page 1 ascending, and to the LAST
    // page descending. Either way it must end up in the signature.
    const oldQueue = (t) => ({ url: 'https://o.rossum.app/api/v1/queues/4', default_score_threshold: t });
    const newQueue = { url: 'https://o.rossum.app/api/v1/queues/900', default_score_threshold: 0.5 };
    const fetcher = (t) => async (path) => (path === first
      ? page([newQueue], 'https://o.rossum.app/api/v1/queues?page=2&page_size=100')
      : page([oldQueue(t)], null));

    const base = signatureFor('thresholdChanged', await collectResponses(check, fetcher(0.8)));
    const moved = signatureFor('thresholdChanged', await collectResponses(check, fetcher(0.95)));
    expect(base[4]).toBe(0.8); // the old queue really is in the signature
    expect(evaluateApi(check, moved, base)).toBe(true);
  });

  it('collectResponses follows pagination.next and merges every page of results', async () => {
    const check = CHECKS.schemaFieldAdded;
    const first = check.paths[0];
    const get = vi.fn(async (path) => {
      if (path === first) {
        return {
          pagination: { next: 'https://org.rossum.app/api/v1/schemas?page=2&page_size=100' },
          results: [{ content: [{ children: [{ id: 'a' }] }] }],
        };
      }
      return { pagination: { next: null }, results: [{ content: [{ children: [{ id: 'b' }, { id: 'c' }] }] }] };
    });
    const responses = await collectResponses(check, get);
    // Both pages counted: 1 + 2 fields. First page only would score 1.
    expect(signatureFor('schemaFieldAdded', responses)).toBe(3);
    // The absolute `next` url is reduced to a path — the content script's
    // allowlist rejects absolute urls and the Academy's fetcher prefixes the
    // domain, so handing either a full url breaks the walk.
    expect(get.mock.calls[1][0]).toBe('/api/v1/schemas?page=2&page_size=100');
  });

  it('does not page a check that did not ask to be paged', async () => {
    // collectionAdded is a POST to Data Storage — a flat list, no pagination.
    const get = vi.fn(async () => ({
      pagination: { next: 'https://org.rossum.app/svc/data-storage/api/v1/collections/list?page=2' },
      result: ['a'],
    }));
    await collectResponses(CHECKS.collectionAdded, get);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('stops rather than spinning on a self-referential next link', async () => {
    const check = CHECKS.schemaFieldAdded;
    const get = vi.fn(async () => ({
      pagination: { next: 'https://org.rossum.app/api/v1/schemas?page=2' }, results: [],
    }));
    await collectResponses(check, get);
    expect(get.mock.calls.length).toBeLessThanOrEqual(51); // 1 + MAX_PAGES
  });
});
