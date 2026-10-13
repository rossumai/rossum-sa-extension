// @vitest-environment jsdom
//
// The connected organization's name: resolved once for the whole Console, and
// appended to each app's connection line. The lookup is deliberately silent on
// failure, so the tests that matter are the ones proving a bar still reads
// exactly as before when no name resolves.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import { connectedOrg } from '../src/console/store.js';
import { resolveOrgLabel } from '../src/console/orgName.js';
import MdhConnectionBar from '../src/mdh/components/ConnectionBar.jsx';
import AuditConnectionBar from '../src/audit/components/ConnectionBar.jsx';
import * as mdhStore from '../src/mdh/store.js';
import * as auditStore from '../src/audit/store.js';
import type { PageInfo } from '../src/audit/api.js';

beforeEach(() => {
  connectedOrg.value = null;
  mdhStore.domain.value = 'https://partner-sandbox.rossum.app';
  auditStore.domain.value = 'https://partner-sandbox.rossum.app';
  auditStore.pageInfo.value = { ...auditStore.pageInfo.value, total: null } satisfies PageInfo;
});

// Every label the bar is given, in order.
async function labels(get: (path: string) => Promise<unknown>) {
  const shown: string[] = [];
  await resolveOrgLabel(get, (label) => shown.push(label));
  return shown;
}

describe('resolveOrgLabel', () => {
  it('ends with the deployment location of the organization group', async () => {
    const get = vi.fn(async (path: string) =>
      path === '/api/v1/organizations'
        ? {
            results: [
              {
                id: 7,
                name: 'Acme Corporation',
                organization_group:
                  'https://partner-sandbox.rossum.app/api/v1/organization_groups/12',
              },
            ],
          }
        : { id: 12, deployment_location: 'prod-eu2' },
    );
    // The name first, without waiting for the group; then the location.
    expect(await labels(get)).toEqual([
      'Acme Corporation · org: 7',
      'Acme Corporation · org: 7 [eu2]',
    ]);
    expect(get).toHaveBeenCalledWith('/api/v1/organization_groups/12');
  });

  it('names the organization without the location when the group cannot be read', async () => {
    const get = async (path: string) => {
      if (path !== '/api/v1/organizations') throw new Error('API error 403');
      return {
        results: [
          {
            id: 7,
            name: 'Acme Corporation',
            organization_group: 'https://partner-sandbox.rossum.app/api/v1/organization_groups/12',
          },
        ],
      };
    };
    expect(await labels(get)).toEqual(['Acme Corporation · org: 7']);
  });

  it('names the organization and its id', async () => {
    const get = async () => ({ results: [{ id: 7, name: 'Acme Corporation' }] });
    expect(await labels(get)).toEqual(['Acme Corporation · org: 7']);
  });

  it('reads the name of the one organization the token can see', async () => {
    const get = vi.fn(async (_path: string) => ({ results: [{ name: 'Acme Corporation' }] }));

    expect(await labels(get)).toEqual(['Acme Corporation']);
    expect(get).toHaveBeenCalledWith('/api/v1/organizations');
  });

  it('names nothing when the token sees several organizations', async () => {
    // The same rule as the Rossum header, so the two can never name different ones.
    const get = async () => ({ results: [{ name: 'Acme Home' }, { name: 'Acme Corporation' }] });
    expect(await labels(get)).toEqual([]);
  });

  it('names nothing when the body carries no organization', async () => {
    expect(await labels(async () => ({ results: [] }))).toEqual([]);
  });

  it('names nothing when the request fails, so the bar keeps its old text', async () => {
    const get = async () => {
      throw new Error('Request timed out after 30s');
    };
    expect(await labels(get)).toEqual([]);
  });
});

describe('connection bars', () => {
  it('appends the name after the domain in Dataset Management', () => {
    connectedOrg.value = 'Acme Corporation';
    const root = document.createElement('div');
    render(<MdhConnectionBar connected={true} />, root);
    expect(root.querySelector('.connection-bar')!.textContent).toContain(
      'Connected to https://partner-sandbox.rossum.app · Acme Corporation',
    );
  });

  it('appends the name after the host in the Audit Log Viewer', () => {
    connectedOrg.value = 'Acme Corporation';
    const root = document.createElement('div');
    render(<AuditConnectionBar connected={true} />, root);
    expect(root.querySelector('.connection-bar')!.textContent).toContain(
      'Connected to partner-sandbox.rossum.app · Acme Corporation',
    );
  });

  it('shows the domain alone in both bars when no name resolved', () => {
    connectedOrg.value = null;
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
