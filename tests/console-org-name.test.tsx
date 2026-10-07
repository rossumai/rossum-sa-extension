// @vitest-environment jsdom
//
// The connected organization's name: resolved once for the whole Console, and
// appended to each app's connection line. The lookup is deliberately silent on
// failure, so the tests that matter are the ones proving a bar still reads
// exactly as before when no name resolves.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import { orgName } from '../src/console/store.js';
import { resolveOrgName } from '../src/console/orgName.js';
import MdhConnectionBar from '../src/mdh/components/ConnectionBar.jsx';
import AuditConnectionBar from '../src/audit/components/ConnectionBar.jsx';
import * as mdhStore from '../src/mdh/store.js';
import * as auditStore from '../src/audit/store.js';
import type { PageInfo } from '../src/audit/api.js';

beforeEach(() => {
  orgName.value = null;
  mdhStore.domain.value = 'https://partner-sandbox.rossum.app';
  auditStore.domain.value = 'https://partner-sandbox.rossum.app';
  auditStore.pageInfo.value = { ...auditStore.pageInfo.value, total: null } satisfies PageInfo;
});

describe('resolveOrgName', () => {
  it('reads the name of the one organization the token can see', async () => {
    const get = vi.fn(async (_path: string) => ({ results: [{ name: 'Acme Corporation' }] }));

    expect(await resolveOrgName(get)).toBe('Acme Corporation');
    expect(get).toHaveBeenCalledWith('/api/v1/organizations');
  });

  it('names nothing when the token sees several organizations', async () => {
    // The same rule as the Rossum header, so the two can never name different ones.
    const get = async () => ({ results: [{ name: 'Acme Home' }, { name: 'Acme Corporation' }] });
    expect(await resolveOrgName(get)).toBeNull();
  });

  it('names nothing when the body carries no organization', async () => {
    expect(await resolveOrgName(async () => ({ results: [] }))).toBeNull();
  });

  it('names nothing when the request fails, so the bar keeps its old text', async () => {
    const get = async () => {
      throw new Error('Request timed out after 30s');
    };
    expect(await resolveOrgName(get)).toBeNull();
  });
});

describe('connection bars', () => {
  it('appends the name after the domain in Dataset Management', () => {
    orgName.value = 'Acme Corporation';
    const root = document.createElement('div');
    render(<MdhConnectionBar connected={true} />, root);
    expect(root.querySelector('.connection-bar')!.textContent).toContain(
      'Connected to https://partner-sandbox.rossum.app · Acme Corporation',
    );
  });

  it('appends the name after the host in the Audit Log Viewer', () => {
    orgName.value = 'Acme Corporation';
    const root = document.createElement('div');
    render(<AuditConnectionBar connected={true} />, root);
    expect(root.querySelector('.connection-bar')!.textContent).toContain(
      'Connected to partner-sandbox.rossum.app · Acme Corporation',
    );
  });

  it('shows the domain alone in both bars when no name resolved', () => {
    orgName.value = null;
    const mdhRoot = document.createElement('div');
    render(<MdhConnectionBar connected={true} />, mdhRoot);
    expect(mdhRoot.querySelector('.connection-bar')!.textContent).toContain(
      'Connected to https://partner-sandbox.rossum.app',
    );
    expect(mdhRoot.querySelector('.connection-bar')!.textContent).not.toContain('· ');

    const auditRoot = document.createElement('div');
    render(<AuditConnectionBar connected={true} />, auditRoot);
    expect(auditRoot.querySelector('.connection-bar')!.textContent).toContain(
      'Connected to partner-sandbox.rossum.app',
    );
    expect(auditRoot.querySelector('.connection-bar')!.textContent).not.toContain('· Acme');
  });
});
