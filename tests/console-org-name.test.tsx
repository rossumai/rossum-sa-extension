// @vitest-environment jsdom
//
// The connected organization's name: resolved once for the whole Console, and
// appended to each app's connection line. The lookup is deliberately silent on
// failure, so the tests that matter are the ones proving a bar still reads
// exactly as before when no name resolves.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import { orgName, orgIsProduction, resolveOrg } from '../src/console/orgName.js';
import MdhConnectionBar from '../src/mdh/components/ConnectionBar.jsx';
import AuditConnectionBar from '../src/audit/components/ConnectionBar.jsx';
import * as mdhStore from '../src/mdh/store.js';
import * as auditStore from '../src/audit/store.js';

function jsonResponse(body: any, ok = true) {
  return { ok, json: async () => body };
}

beforeEach(() => {
  orgName.value = null;
  orgIsProduction.value = null;
  mdhStore.domain.value = 'https://partner-sandbox.rossum.app';
  auditStore.domain.value = 'https://partner-sandbox.rossum.app';
  auditStore.pageInfo.value = { total: null } as any;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveOrg', () => {
  it('reads the name off the first organization the token can see', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ results: [{ name: 'Acme Corporation', sandbox: true }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveOrg('https://partner-sandbox.rossum.app', 'tok')).toEqual({
      name: 'Acme Corporation',
      production: false,
    });
    const [url, opts]: any = fetchMock.mock.calls[0];
    expect(url).toBe('https://partner-sandbox.rossum.app/api/v1/organizations/?page_size=1');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('returns null when the request fails, so the bar keeps its old text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'nope' }, false)),
    );
    expect(await resolveOrg('https://partner-sandbox.rossum.app', 'tok')).toBeNull();
  });

  it('returns null when the body carries no organization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [] })),
    );
    expect(await resolveOrg('https://partner-sandbox.rossum.app', 'tok')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await resolveOrg('https://partner-sandbox.rossum.app', 'tok')).toBeNull();
  });

  it('calls a non-sandbox organization production, and so does a missing flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ name: 'Acme Corporation', sandbox: false }] })),
    );
    expect((await resolveOrg('https://partner-sandbox.rossum.app', 'tok'))!.production).toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [{ name: 'Acme Corporation' }] })),
    );
    expect((await resolveOrg('https://partner-sandbox.rossum.app', 'tok'))!.production).toBe(true);
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

  it('warns PRODUCTION right of the name in both bars, and only on a production org', () => {
    orgName.value = 'Acme Corporation';
    orgIsProduction.value = true;

    for (const Bar of [MdhConnectionBar, AuditConnectionBar]) {
      const root = document.createElement('div');
      render(<Bar connected={true} />, root);
      const bar = root.querySelector('.connection-bar')!;
      const warning = bar.querySelector('.connection-prod')!;
      expect(warning.textContent).toBe('PRODUCTION');
      // Right OF the name: the name is part of the leading text run, and this is
      // the next element after it.
      expect(bar.textContent).toContain('Acme Corporation');
      expect(bar.firstElementChild!.nextElementSibling).toBe(warning);
    }

    orgIsProduction.value = false;
    for (const Bar of [MdhConnectionBar, AuditConnectionBar]) {
      const root = document.createElement('div');
      render(<Bar connected={true} />, root);
      expect(root.querySelector('.connection-prod')).toBeNull();
    }
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
  });
});
