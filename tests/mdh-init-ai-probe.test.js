// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolate the probe logic as a unit (initMdh has heavy side effects); test the
// exported helper that index.jsx uses. index.jsx sources availability from the
// Agent API's probeAgent(), so mock that module directly.
vi.mock('../src/agent/agentApi.js', () => ({ probeAgent: vi.fn(), init: vi.fn() }));

import { resolveAiAvailability } from '../src/mdh/index.jsx';
import * as api from '../src/mdh/api.js';
import { probeAgent } from '../src/agent/agentApi.js';

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  api.init('https://acme.rossum.app', 'tok');
});

describe('resolveAiAvailability', () => {
  it('uses a cached true without probing', async () => {
    sessionStorage.setItem('mdhAiAvailable_org1', 'true');
    expect(await resolveAiAvailability('org1')).toBe(true);
    expect(probeAgent).not.toHaveBeenCalled();
  });
  it('uses a cached false without probing', async () => {
    sessionStorage.setItem('mdhAiAvailable_org1', 'false');
    expect(await resolveAiAvailability('org1')).toBe(false);
    expect(probeAgent).not.toHaveBeenCalled();
  });
  it('probes and caches on a miss (healthy ⇒ available)', async () => {
    probeAgent.mockResolvedValue(true);
    expect(await resolveAiAvailability('org2')).toBe(true);
    expect(sessionStorage.getItem('mdhAiAvailable_org2')).toBe('true');
  });
  it('probes and caches on a miss (unreachable/gated ⇒ unavailable)', async () => {
    probeAgent.mockResolvedValue(false);
    expect(await resolveAiAvailability('org3')).toBe(false);
    expect(sessionStorage.getItem('mdhAiAvailable_org3')).toBe('false');
  });
});
