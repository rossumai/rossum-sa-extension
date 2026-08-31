// @vitest-environment jsdom
//
// End-to-end behaviour of the Search Indexes panel: the Copy button must put a
// clean, create-ready definition on the clipboard (so it pastes straight into
// the Create modal), and runtime state must live in badges, not the JSON.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');
// Force a cache miss so the panel always loads from the (mocked) API.
vi.mock('../src/mdh/cache.js', () => ({ get: () => null, set: () => {}, invalidate: () => {} }));
// Stub the CodeMirror editor — we only care about the card chrome (Copy/badges).
// The stub must honour the JsonEditorHandle contract, not just render: the modal
// reads editorRef.current.isValid()/getParsed() before it submits, so a stub that
// never assigns the ref makes every submit silently short-circuit as "Invalid JSON".
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: ({ value, editorRef }: any) => {
    if (editorRef) {
      editorRef.current = {
        isValid: () => {
          try {
            JSON.parse(value);
            return true;
          } catch {
            return false;
          }
        },
        getParsed: () => JSON.parse(value),
      };
    }
    return <div class="json-editor-stub" />;
  },
}));
// IndexCard's Del goes through confirmModal, which renders into the modal HOST
// component — not mounted here. Keep the rest of the module real and make the
// confirmation immediate so the test exercises the drop path, not the dialog.
vi.mock('../src/mdh/components/Modal.jsx', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    confirmModal: (_title: string, _message: string, onConfirm: () => void) => onConfirm(),
  };
});

import * as api from '../src/mdh/api.js';
import Modal from '../src/mdh/components/Modal.jsx';
import SearchIndexPanel from '../src/mdh/components/SearchIndexPanel.jsx';
import { selectedCollection, activePanel, loading, error } from '../src/mdh/store.js';

const writeText = vi.fn().mockResolvedValue(undefined);

// A real MDH V2 list item: `definition` rather than a latest_definition wrapper,
// runtime state alongside it, and a version record. Null optionals are omitted by
// V2, so the definition here is exactly what a PUT would take back.
function listedIndex(overrides = {}) {
  return {
    name: 'default',
    status: 'READY',
    queryable: true,
    definition: { mappings: { dynamic: false, fields: { name: { type: 'string' } } } },
    latest_definition_version: { version: 0, created_at: '2026-08-28T11:16:21.756000' },
    ...overrides,
  };
}

// The modal host renders openModal() content; the panel alone would set the
// signal and show nothing. It renders empty when no modal is open, so mounting it
// here changes nothing for the tests that never open one. CSS Modules hash the
// host's own class names, so modal queries are scoped to `root`, not to a class.
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(
    <div>
      <SearchIndexPanel />
      <Modal />
    </div>,
    root,
  );
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  selectedCollection.value = 'vendors';
  activePanel.value = 'search-indexes';
  loading.value = false;
  error.value = null;
});

describe('SearchIndexPanel — copy is put-ready', () => {
  it('Copy puts the bare definition on the clipboard', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    const expected = JSON.stringify(
      { mappings: { dynamic: false, fields: { name: { type: 'string' } } } },
      null,
      2,
    );
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  it('copied JSON carries no runtime fields and no name', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    // Assert on parsed top-level keys: mappings legitimately nests its own
    // "type" specs, so a substring check would false-positive.
    const parsed = JSON.parse(writeText.mock.calls[0][0]);
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('queryable');
    expect(parsed).not.toHaveProperty('name');
    expect(parsed).not.toHaveProperty('indexName');
    expect(parsed).not.toHaveProperty('latest_definition_version');
    expect(parsed).toHaveProperty('mappings');
  });
});

describe('SearchIndexPanel — runtime state is in badges, not JSON', () => {
  function badgeTexts(root: any) {
    return [...root.querySelectorAll('.index-badge')].map((b) => b.textContent.toLowerCase());
  }

  it('shows a "not queryable" badge when queryable is false', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex({ queryable: false })] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    expect(badgeTexts(root).some((t) => t.includes('not queryable'))).toBe(true);
  });

  it('does not show a queryable badge when queryable is true', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex({ queryable: true })] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    expect(badgeTexts(root).some((t) => t.includes('queryable'))).toBe(false);
  });
});

// V2 reports states Data Storage never had. The badge keeps the API's own word
// and carries the meaning in a title, so a badge and a support answer match.
describe('SearchIndexPanel — V2 statuses', () => {
  function badgeTexts(root: any) {
    return [...root.querySelectorAll('.index-badge')].map((b) => b.textContent.toLowerCase());
  }

  it('renders PENDING_CREATE as "pending create" with an explanatory title', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'PENDING_CREATE', queryable: false }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.index-badge')).not.toBeNull());
    expect(badgeTexts(root)).toContain('pending create');
    expect(root.querySelector('.index-badge-pending')!.getAttribute('title')).toContain('engine');
  });

  it('shows no type badge — V2 has no type field', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.index-badge')).not.toBeNull());
    expect(badgeTexts(root)).not.toContain('search');
  });

  it('drops through deleteSearchIndex', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    vi.mocked(api.deleteSearchIndex).mockResolvedValue({ message: 'deleted', type: 'info' });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-delete')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-delete')!.click();

    await vi.waitFor(() =>
      expect(api.deleteSearchIndex).toHaveBeenCalledWith('vendors', 'default'),
    );
  });
});

// V2 returns no operation id, so the panel has to see progress by re-reading the
// list. These pin the collection-level line and the resume-on-open behaviour.
// Note: `.toolbar-sync` exists from the first paint (as "no indexes"), so every
// wait below is on real content — waiting on the element itself races the load.
describe('SearchIndexPanel — reconcile', () => {
  it('reports the collection-level state under the title', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex(),
      listedIndex({ name: 'other', status: 'BUILDING', queryable: false }),
    ] as any);
    const root = mount();

    await vi.waitFor(() =>
      expect(root.querySelector('.toolbar-sync')!.textContent).toContain('2 indexes'),
    );
    expect(root.querySelector('.toolbar-sync')!.textContent).toContain('1 in progress');
  });

  it('shows a spinner while work is in flight and a plain dot once settled', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'BUILDING', queryable: false }),
    ] as any);
    const working = mount();
    await vi.waitFor(() =>
      expect(working.querySelector('.toolbar-sync')!.textContent).toContain('in progress'),
    );
    expect(working.querySelector('.toolbar-sync .spin')).not.toBeNull();
    expect(working.querySelector('.toolbar-sync .dot')).toBeNull();

    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const settled = mount();
    await vi.waitFor(() =>
      expect(settled.querySelector('.toolbar-sync')!.textContent).toContain('in sync'),
    );
    expect(settled.querySelector('.toolbar-sync .dot')).not.toBeNull();
    expect(settled.querySelector('.toolbar-sync .spin')).toBeNull();
  });

  it('settles a transitional index to READY on its own, with no user action', async () => {
    vi.mocked(api.listSearchIndexes)
      .mockResolvedValueOnce([listedIndex({ status: 'PENDING_CREATE', queryable: false })] as any)
      .mockResolvedValue([listedIndex()] as any);
    const root = mount();

    // The intermediate paint is too short-lived to assert on without racing it;
    // what matters is that it resolves itself and that a second read happened.
    await vi.waitFor(() => expect(root.textContent).toContain('ready'), { timeout: 5000 });
    expect(root.textContent).not.toContain('pending create');
    expect(vi.mocked(api.listSearchIndexes).mock.calls.length).toBeGreaterThan(1);
  });

  // "stops polling once nothing is transitional" is NOT asserted here. Doing it
  // at this level needs a fixed wait, which races Preact's after-paint effects
  // under full-suite load — it flaked once before being removed. The hook test
  // pins the same behaviour deterministically with fake timers instead.
});

describe('SearchIndexPanel — card detail', () => {
  it('renders cards expanded, with a coverage summary in the header', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card')).not.toBeNull());
    expect(root.querySelector('.record-card-body')).not.toBeNull();
    expect(root.querySelector('.record-summary')!.textContent).toContain('1 field: name');
  });

  it('shows the version and when it was declared', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({
        latest_definition_version: { version: 2, created_at: '2026-08-28T11:16:21.756000' },
      }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.index-card-meta')).not.toBeNull());
    const meta = root.querySelector('.index-card-meta')!.textContent;
    expect(meta).toContain('v2');
    expect(meta).toContain('declared');
  });

  it('shows no meta while the version record has not been written yet', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'READY', latest_definition_version: undefined }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card')).not.toBeNull());
    expect(root.querySelector('.index-card-meta')).toBeNull();
  });

  it('says the previous version is still serving when a failed index is queryable', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'FAILED', queryable: true, latest_definition_version: { version: 2 } }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card-notice')).not.toBeNull());
    const notice = root.querySelector('.record-card-notice')!.textContent;
    expect(notice).toContain('v2');
    expect(notice).toContain('still serving');
  });

  it('adds no notice when a failed index is not queryable', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'FAILED', queryable: false }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card')).not.toBeNull());
    expect(root.querySelector('.record-card-notice')).toBeNull();
    // the existing badge already tells the true story here
    expect(root.textContent).toContain('not queryable');
  });
});

describe('SearchIndexPanel — edit', () => {
  it('Edit opens the modal with the name locked and the definition prefilled, and PUTs it', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()] as any);
    vi.mocked(api.putSearchIndex).mockResolvedValue({ message: 'declared', type: 'info' });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-edit')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-edit')!.click();

    await vi.waitFor(() => expect(root.querySelector('.input')).not.toBeNull());
    const nameInput = root.querySelector<HTMLInputElement>('.input')!;
    expect(nameInput.value).toBe('default');
    expect(nameInput.readOnly).toBe(true);
    expect(nameInput.className).toContain('input-locked');

    root.querySelector<HTMLElement>('.btn-primary')!.click();
    await vi.waitFor(() =>
      expect(api.putSearchIndex).toHaveBeenCalledWith(
        'vendors',
        'default',
        expect.objectContaining({ mappings: expect.anything() }),
      ),
    );
  });

  it('offers Edit definition from the still-serving notice', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'FAILED', queryable: true, latest_definition_version: { version: 2 } }),
    ] as any);
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.record-card-notice')).not.toBeNull());
    expect(root.querySelector('.record-card-notice .btn')!.textContent).toContain(
      'Edit definition',
    );
  });
});

describe('SearchIndexPanel — collections V2 cannot address', () => {
  it('explains a slash-named collection instead of making a request that 404s', async () => {
    selectedCollection.value = 'a/b';
    const root = mount();

    await vi.waitFor(() => expect(root.textContent).toContain('slash'));
    expect(api.listSearchIndexes).not.toHaveBeenCalled();
  });
});
