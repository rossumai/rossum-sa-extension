import { describe, it, expect } from 'vitest';
import {
  cachedOrg,
  currentOrg,
  deploymentLocation,
  orgCacheKey,
  orgLabel,
} from '../src/rossum/orgName.js';

describe('currentOrg', () => {
  it('names the organization, its id, and whether it is a sandbox', () => {
    expect(currentOrg({ results: [{ id: 7, name: 'Acme HQ', sandbox: true }] })).toEqual({
      name: 'Acme HQ',
      id: 7,
      sandbox: true,
      groupPath: null,
      location: null,
    });
  });

  it('keeps the API path of its organization group, on this origin', () => {
    const list = {
      results: [
        {
          name: 'Acme HQ',
          organization_group: 'https://acme.rossum.app/api/v1/organization_groups/12',
        },
      ],
    };
    expect(currentOrg(list)!.groupPath).toBe('/api/v1/organization_groups/12');
  });

  it('ignores a group URL that is not an organization group', () => {
    const list = {
      results: [{ name: 'Acme HQ', organization_group: 'https://acme.rossum.app/api/v1/users/1' }],
    };
    expect(currentOrg(list)!.groupPath).toBeNull();
    expect(
      currentOrg({ results: [{ name: 'Acme HQ', organization_group: 'nonsense' }] })!.groupPath,
    ).toBeNull();
  });

  it('leaves the id out when the API gives none', () => {
    expect(currentOrg({ results: [{ id: '7', name: 'Acme HQ' }] })!.id).toBeNull();
    expect(currentOrg({ results: [{ name: 'Acme HQ' }] })!.id).toBeNull();
  });

  it('counts only `sandbox: true` as a sandbox', () => {
    // The flag marks usage outside the fair-usage policy; anything else is billed.
    for (const sandbox of [false, undefined, 'yes', 1]) {
      expect(currentOrg({ results: [{ name: 'Acme HQ', sandbox }] })!.sandbox).toBe(false);
    }
  });
});

describe('currentOrg, on what it names', () => {
  it('names the one organization the session can see', () => {
    expect(currentOrg({ results: [{ id: 7, name: 'Acme HQ - TEST' }] })!.name).toBe(
      'Acme HQ - TEST',
    );
  });

  it('trims the name', () => {
    expect(currentOrg({ results: [{ id: 7, name: '  Acme HQ ' }] })!.name).toBe('Acme HQ');
  });

  it('names nothing when the session sees several organizations', () => {
    // Which one is current cannot be told from the list, and a wrong name is worse than none.
    const list = {
      results: [
        { id: 3, name: 'Acme Home' },
        { id: 7, name: 'Acme HQ' },
      ],
    };
    expect(currentOrg(list)).toBeNull();
  });

  it('names nothing for an empty or malformed list', () => {
    expect(currentOrg({ results: [] })).toBeNull();
    expect(currentOrg({ results: [{ id: 7 }] })).toBeNull();
    expect(currentOrg({ results: [{ id: 7, name: '   ' }] })).toBeNull();
    expect(currentOrg({})).toBeNull();
    expect(currentOrg(null)).toBeNull();
  });
});

describe('cachedOrg', () => {
  const org = { name: 'Acme HQ', id: 7, sandbox: false, groupPath: null, location: 'prod-eu2' };
  const entry = (at: number, value: unknown = org) => JSON.stringify({ at, org: value });

  it('reads back an organization stored within the day', () => {
    expect(cachedOrg(entry(1_000), 1_000 + 24 * 3_600_000 - 1)).toEqual(org);
  });

  it('forgets it after a day, so a rename still shows', () => {
    expect(cachedOrg(entry(1_000), 1_000 + 24 * 3_600_000)).toBeNull();
  });

  it('drops a cached group path that is not an organization group', () => {
    // It decides where a token-bearing request goes, so it is checked like a fresh one.
    expect(cachedOrg(entry(0, { ...org, groupPath: '/api/v1/users/1' }), 0)!.groupPath).toBeNull();
    expect(
      cachedOrg(entry(0, { ...org, groupPath: '/api/v1/organization_groups/12' }), 0)!.groupPath,
    ).toBe('/api/v1/organization_groups/12');
  });

  it('ignores anything it did not write', () => {
    expect(cachedOrg(null, 0)).toBeNull();
    expect(cachedOrg('not json', 0)).toBeNull();
    expect(cachedOrg(entry(0, { name: 'Acme HQ' }), 0)).toBeNull();
    expect(cachedOrg(entry(0, { ...org, name: '' }), 0)).toBeNull();
  });
});

describe('orgCacheKey', () => {
  it('is stable for a token and differs between tokens', () => {
    expect(orgCacheKey('tok-a')).toBe(orgCacheKey('tok-a'));
    expect(orgCacheKey('tok-a')).not.toBe(orgCacheKey('tok-b'));
  });

  it('never contains the token', () => {
    const token = '0123456789abcdef0123456789abcdef01234567';
    expect(orgCacheKey(token)).not.toContain(token.slice(0, 8));
    expect(orgCacheKey(token)).toMatch(/^rossum-sa-extension-org:[0-9a-f]{1,8}$/);
  });
});

describe('deploymentLocation', () => {
  it('reads where the organization group is deployed', () => {
    expect(deploymentLocation({ id: 12, deployment_location: 'prod-eu2' })).toBe('eu2');
  });

  it('keeps any other prefix, so a non-production deployment stands out', () => {
    expect(deploymentLocation({ deployment_location: 'stage-eu1' })).toBe('stage-eu1');
    expect(deploymentLocation({ deployment_location: 'eu2' })).toBe('eu2');
  });

  it('is null when the group does not say', () => {
    expect(deploymentLocation({ id: 12 })).toBeNull();
    expect(deploymentLocation({ deployment_location: '' })).toBeNull();
    expect(deploymentLocation(null)).toBeNull();
  });
});

describe('orgLabel', () => {
  const org = { name: 'Acme HQ', id: 7, sandbox: false, groupPath: null, location: null };

  it('names the organization and its id, header style by default', () => {
    expect(orgLabel(org)).toBe('Acme HQ: 7');
  });

  it('takes the separator the Console uses', () => {
    expect(orgLabel(org, ' \u00b7 org: ')).toBe('Acme HQ \u00b7 org: 7');
  });

  it('is the name alone when the API gave no id', () => {
    expect(orgLabel({ ...org, id: null })).toBe('Acme HQ');
  });

  it('ends with the deployment location in brackets', () => {
    expect(orgLabel({ ...org, location: 'eu2' })).toBe('Acme HQ: 7 [eu2]');
    expect(orgLabel({ ...org, location: 'eu2' }, ' \u00b7 org: ')).toBe(
      'Acme HQ \u00b7 org: 7 [eu2]',
    );
    expect(orgLabel({ ...org, id: null, location: 'eu2' })).toBe('Acme HQ [eu2]');
  });
});
