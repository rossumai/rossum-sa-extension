// tests/devtools-version-diff.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import VersionDiff from '../src/devtools/VersionDiff.jsx';
import * as store from '../src/devtools/store.js';

async function waitFor(fn: () => boolean, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

const e = (version_id: number, over: any = {}) =>
  ({
    version_id,
    object_type: 'hook',
    object_id: 48,
    version_event: 'update',
    changed_fields: ['config'],
    version_created_at: '2026-09-22T09:00:00Z',
    modifier_id: 7,
    ...over,
  }) as any;
let root: HTMLDivElement;
afterEach(() => {
  render(null, root);
  root.remove();
});

function mount(entry: any, knownEntries: any[], get: any, onCompared = vi.fn()) {
  root = document.createElement('div');
  document.body.appendChild(root);
  render(
    <VersionDiff
      entry={entry}
      knownEntries={knownEntries}
      get={get}
      users={new Map([[7, 'Jane Doe']])}
      onCompared={onCompared}
    />,
    root,
  );
  return onCompared;
}

const snap = (timeout_s: number) => ({ id: 48, config: { timeout_s, secret: '**REDACTED**' } });

// VersionDiff caches snapshots for the panel's lifetime (module scope), so every test uses
// its own version ids — a shared id would be served from an earlier test's cache.
describe('VersionDiff', () => {
  it('diffs a version against the one before it, fetched in one call', async () => {
    const get = vi.fn(async (_p: string) => ({
      results: [
        { ...e(9), snapshot: snap(60) },
        { ...e(5), snapshot: snap(30) },
      ],
    }));
    mount(e(9), [e(9), e(5)], get);
    await waitFor(() => !!root.querySelector('.cm-editor'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(new URL(`https://x${get.mock.calls[0][0]}`).searchParams.get('version_id')).toBe('9,5');
    expect(root.querySelector('.cm-deletedChunk, .cm-changedLine')).not.toBeNull();
    expect(root.textContent).toContain('Jane Doe');
    expect(root.querySelector('.rawjson-histdiff-banner a')).toBeNull(); // Diff ↗ lives on the rail row
  });

  it('finds the previous version with a query when it is not loaded', async () => {
    const get = vi.fn(async (p: string) =>
      p.includes('include_snapshot')
        ? {
            results: [
              { ...e(19), snapshot: snap(60) },
              { ...e(14), snapshot: snap(30) },
            ],
          }
        : { pagination: {}, results: [e(14)] },
    );
    mount(e(19), [e(19)], get);
    await waitFor(() => !!root.querySelector('.cm-editor'));
    expect(get.mock.calls[0][0]).toContain('version_id_range_max=18');
  });

  it('shows a create version on its own', async () => {
    const created = e(21, { version_event: 'create', changed_fields: [] });
    const get = vi.fn(async () => ({ results: [{ ...created, snapshot: snap(30) }] }));
    mount(created, [], get);
    await waitFor(() => !!root.querySelector('.cm-editor'));
    expect(root.querySelector('.cm-deletedChunk')).toBeNull();
  });

  it('says secrets changed when changed_fields lists them', async () => {
    const changed = e(29, { changed_fields: ['secrets'] });
    const get = vi.fn(async () => ({
      results: [
        { ...changed, snapshot: snap(30) },
        { ...e(25), snapshot: snap(30) },
      ],
    }));
    mount(changed, [e(25)], get);
    await waitFor(() => root.textContent!.includes('secrets changed, values hidden'));
  });

  it('reports a missing previous snapshot instead of an empty diff', async () => {
    const get = vi.fn(async () => ({ results: [{ ...e(39), snapshot: snap(60) }] }));
    mount(e(39), [e(39), e(35)], get);
    await waitFor(() => root.textContent!.includes('Could not load the previous version'));
    expect(root.querySelector('.cm-editor')).toBeNull();
  });

  it('says when and by whom for both versions, never a version id, and has no Back to live', async () => {
    const get = vi.fn(async (p: string) =>
      p.startsWith('/api/v1/users')
        ? { results: [{ id: 8, first_name: 'John', last_name: 'Roe' }] }
        : {
            results: [
              { ...e(49), snapshot: snap(60) },
              { ...e(45, { modifier_id: 8 }), snapshot: snap(30) },
            ],
          },
    );
    const onCompared = mount(e(49), [e(45, { modifier_id: 8 })], get);
    await waitFor(() => root.textContent!.includes('John Roe'));
    const banner = root.querySelector('.rawjson-histdiff-banner')!.textContent!;
    expect(banner).toMatch(/^Changes from .+ by Jane Doe, against the version from .+ by John Roe/);
    expect(banner).not.toMatch(/v\d+/);
    expect(onCompared).toHaveBeenCalledWith(45);
    expect(root.querySelector('.rawjson-histdiff-back')).toBeNull();
    expect(root.textContent).not.toContain('Back to live');
  });

  it('says Created for a create, and reports nothing to compare against', async () => {
    const created = e(51, { version_event: 'create', changed_fields: [] });
    const get = vi.fn(async () => ({ results: [{ ...created, snapshot: snap(30) }] }));
    const onCompared = mount(created, [], get);
    await waitFor(() => !!root.querySelector('.cm-editor'));
    expect(root.querySelector('.rawjson-histdiff-banner')!.textContent).toMatch(
      /^Created .+ by Jane Doe/,
    );
    expect(onCompared).toHaveBeenCalledWith(null);
  });

  it('explains a diff that is blank because the API redacted the changed values', async () => {
    const get = vi.fn(async () => ({
      results: [
        { ...e(59), snapshot: snap(30) },
        { ...e(55), snapshot: snap(30) },
      ],
    }));
    mount(e(59), [e(59), e(55)], get);
    await waitFor(() => !!root.querySelector('.cm-editor'));
    expect(root.textContent).toContain(
      'No visible difference \u2014 the changed values are redacted by the API.',
    );
  });

  it('shows no redaction notice when the snapshots differ', async () => {
    const get = vi.fn(async () => ({
      results: [
        { ...e(69), snapshot: snap(60) },
        { ...e(65), snapshot: snap(30) },
      ],
    }));
    mount(e(69), [e(69), e(65)], get);
    await waitFor(() => !!root.querySelector('.cm-editor'));
    expect(root.textContent).not.toContain('No visible difference');
  });
});

describe('VersionDiff soft-wrap', () => {
  it('follows Soft-wrap live without rebuilding the diff', async () => {
    store.lineWrap.value = false;
    const get = vi.fn(async () => ({
      results: [
        { ...e(69), snapshot: snap(60) },
        { ...e(65), snapshot: snap(30) },
      ],
    }));
    mount(e(69), [e(65)], get);
    await waitFor(() => !!root.querySelector('.cm-content'));
    const content = root.querySelector('.cm-content')!;
    expect(content.classList.contains('cm-lineWrapping')).toBe(false);
    store.lineWrap.value = true;
    await waitFor(() => content.classList.contains('cm-lineWrapping'));
    expect(root.querySelector('.cm-content')).toBe(content); // same view
    store.lineWrap.value = false;
  });
});
