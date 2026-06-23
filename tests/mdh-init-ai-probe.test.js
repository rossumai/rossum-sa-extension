// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolate the probe logic as a unit (initMdh has heavy side effects); test the
// exported helper that index.jsx uses. Mock fetch (repo convention) rather than
// spying on the ESM namespace.
import { resolveAiAvailability } from '../src/mdh/index.jsx';
import * as api from '../src/mdh/api.js';

beforeEach(() => {
  sessionStorage.clear();
  api.init('https://acme.rossum.app', 'tok');
});

describe('resolveAiAvailability', () => {
  it('uses a cached true without probing', async () => {
    sessionStorage.setItem('mdhAiAvailable_org1', 'true');
    const f = vi.fn();
    globalThis.fetch = f;
    expect(await resolveAiAvailability('org1')).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
  it('uses a cached false without probing', async () => {
    sessionStorage.setItem('mdhAiAvailable_org1', 'false');
    const f = vi.fn();
    globalThis.fetch = f;
    expect(await resolveAiAvailability('org1')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('probes and caches on a miss (400 ⇒ available)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({}) });
    expect(await resolveAiAvailability('org2')).toBe(true);
    expect(sessionStorage.getItem('mdhAiAvailable_org2')).toBe('true');
  });
  it('probes and caches on a miss (403 ⇒ unavailable)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) });
    expect(await resolveAiAvailability('org3')).toBe(false);
    expect(sessionStorage.getItem('mdhAiAvailable_org3')).toBe('false');
  });
});
