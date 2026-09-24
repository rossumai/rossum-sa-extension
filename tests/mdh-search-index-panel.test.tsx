// @vitest-environment jsdom
//
// End-to-end behaviour of the Search Indexes panel: the Copy button must put a
// clean, create-ready definition on the clipboard (so it pastes straight into
// the Create modal), and runtime state must live in badges, not the JSON.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import { useRef } from 'preact/hooks';

vi.mock('../src/mdh/api.js');
// Force a cache miss so the panel always loads from the (mocked) API.
vi.mock('../src/mdh/cache.js', () => ({ get: () => null, set: () => {}, invalidate: () => {} }));
// Stub the CodeMirror editor — we only care about the card chrome (Copy/badges).
// The stub must honour the JsonEditorHandle contract, not just render: the modal
// reads editorRef.current.isValid()/getParsed() before it submits, so a stub that
// never assigns the ref makes every submit silently short-circuit as "Invalid JSON".
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  // `useRef` (not a plain closure `let`) so the buffer survives a re-render of
  // the parent modal: the real CodeMirror-backed component reads `value` only
  // once at mount and mutates its own document thereafter via the imperative
  // handle, and a stub that re-seeds from `value` on every render silently
  // discards whatever a preset just wrote the moment the modal's own state
  // (e.g. which preset is selected) changes.
  default: ({ value, editorRef, fill }: any) => {
    const bufRef = useRef(value);
    if (editorRef) {
      editorRef.current = {
        getValue: () => bufRef.current,
        setValue: (v: string) => {
          bufRef.current = v;
        },
        isValid: () => {
          try {
            JSON.parse(bufRef.current);
            return true;
          } catch {
            return false;
          }
        },
        getParsed: () => JSON.parse(bufRef.current),
      };
    }
    return (
      <div class="json-editor-stub" data-fill={fill ? '1' : undefined}>
        {/* Test-only escape hatch that mutates the buffer WITHOUT going through
            setValue — the only way a test can simulate the user hand-typing over
            what a preset wrote, which is exactly the distinction the dirty-editor
            guard (Finding 1) has to make. Nothing in the real editor renders a
            textarea; this exists only for the tests below. */}
        <textarea
          data-testid="json-editor-hand-edit"
          onInput={(e: any) => {
            bufRef.current = e.target.value;
          }}
        />
      </div>
    );
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
import Modal, { closeModal } from '../src/mdh/components/Modal.jsx';
import mstyles from '../src/ui/Modal.module.css';
import SearchIndexPanel from '../src/mdh/components/SearchIndexPanel.jsx';
import { selectedCollection, activePanel, loading, error } from '../src/mdh/store.js';
import { defaultPreset } from '../src/mdh/searchIndexPresets.js';

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

// `modalContent` is a module-level signal, and `mount()` never unmounts a
// previous test's tree. A modal a test forgot to close stays open in that
// signal, so the NEXT test's fresh `<Modal/>` renders it on first paint —
// re-running a stale render closure's hooks (preset/paths/fields/etc.) whose
// async effects then fire during a LATER test's window. Closing here, not just
// where a test happens to click Cancel, keeps every test's modal state local.
afterEach(() => {
  closeModal();
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

    await vi.waitFor(() => expect(root.querySelector('[role="dialog"] .input')).not.toBeNull());
    const nameInput = root.querySelector<HTMLInputElement>('[role="dialog"] .input')!;
    expect(nameInput.value).toBe('default');
    expect(nameInput.readOnly).toBe(true);
    expect(nameInput.className).toContain('input-locked');

    root.querySelector<HTMLElement>('[role="dialog"] .btn-primary')!.click();
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

describe('SearchIndexPanel — presets', () => {
  beforeEach(() => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.putSearchIndex).mockResolvedValue({});
  });

  async function openCreate(root: HTMLElement) {
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();
  }

  // "Whole-word match" is the create-mode default: the chip is selected AND the
  // editor already holds its output. The old seed was a bare
  // {mappings:{dynamic:true}} — a plain dynamic index on lucene.standard, which
  // is measurably NOT what the server's own `default` index does, so pressing
  // Create without touching anything used to build something subtly different
  // from the index every collection already gets.
  it('opens with "Whole-word match" selected', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    const labels = [...root.querySelectorAll('[data-testid="preset-row"] button')].map(
      (n) => n.textContent,
    );
    expect(labels[0]).toBe('Custom');
    expect(root.querySelector('[data-testid="preset-custom"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(root.querySelector('[data-testid="preset-default"]')!.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  // Verified live 2026-09-01: this minimal definition reaches READY and
  // queryable, and round-trips back byte-identical.
  it('submits the minimal definition when nothing is touched', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'straight_through';
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, , definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [string, string, any];
    expect(definition).toEqual({ mappings: { dynamic: true } });
    // No analyzer keys: the minimal definition runs on lucene.standard, and
    // reproducing the server's own `default` index is what the next tab is for.
    expect(definition.analyzers).toBeUndefined();
  });

  it('still builds the house-analyzer definition when Whole-word match is chosen', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'house';
    (root.querySelector('[data-testid="preset-default"]') as HTMLElement).click();
    await Promise.resolve();
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, , definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [string, string, any];
    expect(definition.analyzer).toBe('default_whitespace_lowercase');
    expect(definition.analyzers[0].charFilters[0].mappings).toEqual({
      '.': ' ',
      '/': '',
      '\\': '',
      '-': ' ',
      ',': ' ',
    });
  });

  // The wizards render their Segmented with the `tabs` variant; the preset row
  // uses the same one so the modal does not invent a second control style.
  it('renders the preset row as tabs, like the import and export wizards', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    expect(root.querySelector('[data-testid="preset-row"]')!.className).toContain('seg-tabs');
  });

  it('offers both presets in create mode', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    const labels = [...root.querySelectorAll('[data-testid="preset-row"] button')].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['Custom', 'Whole-word match', 'Fuzzy match']);
  });

  it('writes the fuzzy definition into the editor and submits exactly that', async () => {
    // A field has to be chosen, or the submit-time unmatchable-definition guard
    // (Finding 2) refuses it — dynamic:false with no fields can never match
    // anything. Discovery rejected so the deterministic free-text fallback is
    // the field source, same pattern as the "field picker" tests below.
    vi.mocked(api.aggregate).mockRejectedValue(new Error('no discovery'));
    const root = mount();
    await Promise.resolve();
    await openCreate(root);

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_fuzzy';
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    await vi.waitFor(() => expect(vi.mocked(api.aggregate)).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="field-fallback"]')).not.toBeNull(),
    );

    const path = root.querySelector('[data-testid="field-fallback"]') as HTMLInputElement;
    path.value = 'vendor_name';
    path.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, indexName, definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [
      string,
      string,
      any,
    ];
    expect(indexName).toBe('vendor_fuzzy');
    expect(definition.analyzers[0].tokenFilters).toEqual([
      { type: 'lowercase' },
      { type: 'icuFolding' },
    ]);
  });

  // An Edit modal opens on a customer's existing definition. A chip that
  // overwrites it in one click is "never delete customer data" in a costume.
  it('shows no presets in edit mode', async () => {
    const root = mount();
    // Unlike openCreate above, Edit needs a rendered IndexCard, which needs the
    // mocked listSearchIndexes() to resolve and flow through a state update —
    // more than one microtask tick, so this waits on the condition rather than
    // assuming a fixed number of `await Promise.resolve()` flushes it.
    await vi.waitFor(() => expect(root.querySelector('.action-edit')).not.toBeNull());
    const edit = root.querySelector('.action-edit') as HTMLElement;
    edit.click();
    await Promise.resolve();
    expect(root.querySelector('[data-testid="preset-row"]')).toBeNull();
  });
});

describe('SearchIndexPanel — field picker', () => {
  beforeEach(() => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.putSearchIndex).mockResolvedValue({});
    vi.mocked(api.aggregate).mockResolvedValue({
      result: [
        {
          f0: [
            { _id: 'vendor_name', types: ['string'] },
            { _id: 'vat', types: ['string'] },
          ],
        },
      ],
    });
  });

  it('offers discovered paths once the fuzzy preset is chosen', async () => {
    const root = mount();
    await Promise.resolve();
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    // The discovery aggregate runs from a `useEffect`, which Preact flushes
    // after paint (via requestAnimationFrame), not on the next microtask — a
    // fixed number of `await Promise.resolve()` ticks never observes it.
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="field-picker"]')).not.toBeNull(),
    );
  });

  it('names the chosen fields in the submitted definition, with the keyword alternate', async () => {
    // Discovery off, so the fallback input is the field source for this test.
    vi.mocked(api.aggregate).mockRejectedValue(new Error('no discovery'));
    const root = mount();
    await Promise.resolve();
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    // Prove discovery actually ran (and can therefore actually fail) before
    // touching the fallback — the pre-effect initial render looks identical to
    // the post-failure one, so asserting on the fallback alone after a fixed
    // number of ticks would pass even with the discovery effect deleted.
    await vi.waitFor(() => expect(vi.mocked(api.aggregate)).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="field-fallback"]')).not.toBeNull(),
    );

    // Set the field through the documented free-text fallback rather than the
    // combobox keyboard flow: MatchKeyPicker has its own tests, and a window
    // test-seam has no business shipping in the bundle.
    const path = root.querySelector('[data-testid="field-fallback"]') as HTMLInputElement;
    path.value = 'vendor_name';
    path.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    const alt = root.querySelector('[data-testid="exact-alternate"]') as HTMLInputElement;
    alt.checked = true;
    alt.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_fuzzy';
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, , definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [string, string, any];
    expect(Object.keys(definition.mappings.fields)).toEqual(['vendor_name']);
    expect(definition.mappings.fields.vendor_name.multi.exact.analyzer).toBe('lucene.keyword');
  });

  // Discovery is a convenience. Losing it must not stop anyone creating an index.
  it('falls back to a free-text path when discovery fails', async () => {
    vi.mocked(api.aggregate).mockRejectedValue(new Error('nope'));
    const root = mount();
    await Promise.resolve();
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    // Prove discovery actually ran (and can therefore actually fail) before
    // asserting on the fallback. Without this, the pre-effect initial render
    // (paths.value: null, paths.loading: false) renders the identical fallback
    // markup the post-failure state does, so the assertion below would pass
    // unchanged even with the whole discovery `useEffect` deleted.
    await vi.waitFor(() => expect(vi.mocked(api.aggregate)).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="field-fallback"]')).not.toBeNull(),
    );
  });
});

// Finding 1 (Important, 2026-08-31 review): the field-picker effect used to call
// editorRef.current.setValue(...) unconditionally, bypassing the dirty guard the
// preset chips already had. Reproduced by the reviewer: pick Fuzzy match,
// hand-edit the JSON, tick one more field — the hand-edit used to be silently
// destroyed. These tests pin the fix and the surrounding inline-confirm UI that
// had no coverage at all before this pass (Finding 6).
describe('SearchIndexPanel — dirty editor guard', () => {
  beforeEach(() => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.putSearchIndex).mockResolvedValue({});
  });

  async function openCreate(root: HTMLElement) {
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();
  }

  function handEdit(root: HTMLElement, json: string) {
    // Scoped to the open dialog: a READY index card in the list behind the modal
    // renders its own (read-only, in the real component) JsonEditor instance
    // through the very same stub, so an unscoped query can silently hit the
    // card's textarea instead of the modal's — the card is earlier in DOM order.
    const dialog = root.querySelector('[role="dialog"]')!;
    const edit = dialog.querySelector(
      '[data-testid="json-editor-hand-edit"]',
    ) as HTMLTextAreaElement;
    edit.value = json;
    edit.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('asks before replacing a hand-edited editor when a preset chip is clicked again', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    await Promise.resolve();

    handEdit(
      root,
      JSON.stringify({ mappings: { dynamic: false, fields: { extra: { type: 'number' } } } }),
    );
    await Promise.resolve();

    (root.querySelector('[data-testid="preset-default"]') as HTMLElement).click();
    await Promise.resolve();

    // The tab row stays mounted — replacing it would remount the editor below and
    // destroy the edits this confirm exists to protect.
    expect(root.querySelector('[data-testid="preset-row"]')).not.toBeNull();
    expect(root.textContent).toContain('Replace your edits with this preset?');
    // Nothing was submitted yet — asking is not the same as replacing.
    expect(api.putSearchIndex).not.toHaveBeenCalled();
  });

  it('"Keep mine" leaves the hand-edited definition untouched', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    await Promise.resolve();

    const handEdited = { mappings: { dynamic: false, fields: { extra: { type: 'number' } } } };
    handEdit(root, JSON.stringify(handEdited));
    await Promise.resolve();

    (root.querySelector('[data-testid="preset-default"]') as HTMLElement).click();
    await Promise.resolve();

    const keepMine = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Keep mine',
    )!;
    keepMine.click();
    await Promise.resolve();

    // The confirm is gone and the ordinary preset row is back.
    expect(root.querySelector('[data-testid="preset-row"]')).not.toBeNull();

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_fuzzy';
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, , definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [string, string, any];
    expect(definition).toEqual(handEdited);
  });

  it('"Replace" overwrites the hand-edited definition with the chosen preset', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    await Promise.resolve();

    handEdit(
      root,
      JSON.stringify({ mappings: { dynamic: false, fields: { extra: { type: 'number' } } } }),
    );
    await Promise.resolve();

    (root.querySelector('[data-testid="preset-default"]') as HTMLElement).click();
    await Promise.resolve();

    const replace = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Replace')!;
    replace.click();
    await Promise.resolve();

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_default';
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, , definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [string, string, any];
    expect(definition).toEqual(defaultPreset());
  });

  // The reviewer's exact repro: Fuzzy match, hand-edit, then use the field
  // picker rather than a preset chip. Before the fix this silently destroyed the
  // hand-edit and reset lastPresetJson with no record that it had happened.
  it('routes a field-picker change through the same dirty guard as a preset click', async () => {
    vi.mocked(api.aggregate).mockRejectedValue(new Error('no discovery'));
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    await vi.waitFor(() => expect(vi.mocked(api.aggregate)).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="field-fallback"]')).not.toBeNull(),
    );

    const handEdited = { mappings: { dynamic: false, fields: { extra: { type: 'number' } } } };
    handEdit(root, JSON.stringify(handEdited));
    await Promise.resolve();

    // Tick one more field via the picker, exactly as in the reviewer's repro.
    const path = root.querySelector('[data-testid="field-fallback"]') as HTMLInputElement;
    path.value = 'vendor_name';
    path.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    // Asked, not silently overwritten.
    expect(root.textContent).toContain('Replace your edits with this preset?');

    const keepMine = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Keep mine',
    )!;
    keepMine.click();
    await Promise.resolve();

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_fuzzy';
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();
    await Promise.resolve();

    const [, , definition] = vi.mocked(api.putSearchIndex).mock.calls[0] as [string, string, any];
    // The submitted definition is still the hand-edit — the picker's field never
    // made it in, because the user chose to keep their own work.
    expect(definition).toEqual(handEdited);
  });
});

// Finding 2 (Important, 2026-08-31 review): {mappings: {dynamic: false}} with no
// fields is valid V2 input and builds a READY index that matches zero documents
// forever — a fifth silent-failure mode inside the feature built to remove four.
// Checked at submit time on the definition's SHAPE, not on which preset produced
// it, so a hand-typed definition with the same flaw is caught too.
describe('SearchIndexPanel — unmatchable-definition guard', () => {
  beforeEach(() => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.putSearchIndex).mockResolvedValue({});
  });

  it('refuses to submit the fuzzy preset with no fields chosen, and explains why', async () => {
    vi.mocked(api.aggregate).mockRejectedValue(new Error('no discovery'));
    const root = mount();
    await Promise.resolve();
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_fuzzy';
    (root.querySelector('[data-testid="preset-fuzzy"]') as HTMLElement).click();
    await Promise.resolve();

    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();

    expect(api.putSearchIndex).not.toHaveBeenCalled();
    expect(root.querySelector('.input-hint')!.textContent).toContain('can never match anything');
  });

  it('refuses a hand-typed definition with the same shape — the guard is general, not preset-specific', async () => {
    const root = mount();
    await Promise.resolve();
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();

    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_hand';
    // Scoped to the open dialog — see the comment on the shared handEdit() helper
    // above: an already-rendered READY card uses the same JsonEditor stub and
    // sits earlier in DOM order, so an unscoped query can hit its textarea instead.
    const dialog = root.querySelector('[role="dialog"]')!;
    const edit = dialog.querySelector(
      '[data-testid="json-editor-hand-edit"]',
    ) as HTMLTextAreaElement;
    edit.value = JSON.stringify({ mappings: { dynamic: false } });
    edit.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();

    expect(api.putSearchIndex).not.toHaveBeenCalled();
  });

  it('allows dynamic:true with no fields — dynamic mapping can still match', async () => {
    const root = mount();
    await Promise.resolve();
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();

    // Untouched seed is exactly {"mappings":{"dynamic":true}} — the "Same as
    // default"-shaped case the guard must never block.
    const name = root.querySelector('[role="dialog"] input.input') as HTMLInputElement;
    name.value = 'vendor_default';
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;
    submit.click();
    await Promise.resolve();

    expect(api.putSearchIndex).toHaveBeenCalled();
  });
});

describe('SearchIndexPanel — check', () => {
  const valueInput = (root: HTMLElement) =>
    root.querySelector('[data-testid="check-value"]') as HTMLInputElement | null;

  // vi.waitFor only retries on a THROW — a predicate that just returns
  // querySelector's result would resolve with null on the first (empty) check
  // rather than waiting for the async list load, so assert inside it.
  // The row runs on its own after a pause in typing (real timers here, so the
  // callers' vi.waitFor absorbs the debounce).
  async function run(root: HTMLElement, value: string) {
    await vi.waitFor(() => expect(valueInput(root)).not.toBeNull());
    const input = valueInput(root)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(api.aggregate).toHaveBeenCalled());
  }

  it('shows the test row on a READY index', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    const root = mount();
    await vi.waitFor(() => expect(valueInput(root)).not.toBeNull());
  });

  // A $search against a building index returns [] with code "ok". Without this
  // guard Check would report "no matches" for an index that is merely unfinished.
  it('offers no test row while the index is still building, and says why', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ status: 'PENDING_CREATE', queryable: false }),
    ]);
    const root = mount();
    // Wait for the card itself, then assert the row is absent from it —
    // otherwise this passes vacuously before the list has even rendered.
    await vi.waitFor(() => expect(root.querySelector('.record-card')).not.toBeNull());
    expect(valueInput(root)).toBeNull();
    expect(root.querySelector('[data-testid="check-unavailable"]')!.textContent).toContain('READY');
  });

  it('runs one read-only aggregate against that index and shows the hits', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.aggregate).mockResolvedValue({
      result: [
        {
          score: 2.9,
          highlights: [
            { score: 1, path: 'name', texts: [{ value: 'Acme Metallwerke', type: 'hit' }] },
          ],
        },
      ],
    });
    const root = mount();
    await run(root, 'acme');

    const [collection, pipeline] = vi.mocked(api.aggregate).mock.calls[0];
    expect(collection).toBe('vendors');
    expect(pipeline.map((s: any) => Object.keys(s)[0])).toEqual(['$search', '$limit', '$project']);
    expect((pipeline[0] as any).$search.index).toBe('default');
    expect((pipeline[0] as any).$search.text.query).toBe('acme');
    // The result reaches the DOM only after the mocked aggregate promise
    // resolves and Preact re-renders — vi.waitFor rather than a guessed tick
    // count, since the guess for a nested async chain is easy to get wrong.
    await vi.waitFor(() => expect(root.textContent).toContain('Acme Metallwerke'));
  });

  // The old strip asked for a path on a dynamic index; the wildcard made that
  // question unnecessary.
  it('needs no path on a dynamic index', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([
      listedIndex({ definition: { mappings: { dynamic: true } } }),
    ]);
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount();
    await run(root, 'acme');
    expect(root.querySelector('[data-testid="check-path"]')).toBeNull();
    const [, pipeline] = vi.mocked(api.aggregate).mock.calls[0];
    expect((pipeline[0] as any).$search.text.path).toEqual({ wildcard: '*' });
  });

  it('reports an empty result as an outcome, not an error', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount();
    await run(root, 'acme');
    await vi.waitFor(() => expect(root.textContent).toContain('No match'));
    expect(error.value).toBeNull();
  });

  // A network failure, an auth failure, or a malformed-definition rejection is
  // not a miss. Collapsing it into "No match" would make Check a new silent
  // failure of exactly the kind it exists to catch — so a rejected aggregate
  // must produce a distinct outcome, and must never touch the panel-level
  // error signal (this strip's failure is local to the card, not the panel).
  it('reports a failed check as an error, not as "No match", and leaves the panel error alone', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue([listedIndex()]);
    vi.mocked(api.aggregate).mockRejectedValue(new Error('network error'));
    const root = mount();
    await run(root, 'acme');
    await vi.waitFor(() => expect(root.textContent).toContain('could not run'));
    expect(root.textContent).not.toContain('No match');
    expect(error.value).toBeNull();
  });
});

// jsdom has no layout, so this asserts the STRUCTURE behind a card that does not
// resize as the user switches presets. Measured in Chrome before the change: the
// card grew 591→850px and the tab row moved 129px between Custom and Whole-word,
// because the JSON editor grew with its content and a centred card that grows
// moves its own top edge.
describe('SearchIndexPanel — create modal holds its size', () => {
  async function openCreate(root: HTMLElement) {
    const create = [...root.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Create'),
    )!;
    create.click();
    await Promise.resolve();
  }

  it('flexes the body inside a stable card and pins the buttons outside it', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    const card = root.querySelector('[role="dialog"]')!;
    const body = card.querySelector('.' + mstyles.body)!;
    const submit = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create Search Index',
    )!;

    expect(body.classList.contains(mstyles.stableBody)).toBe(true);
    // Inside the body the buttons scroll with the content and move whenever it
    // changes height; as a card child they cannot.
    expect(body.contains(submit)).toBe(false);
    expect(submit.closest('.' + mstyles.actions)!.parentElement).toBe(card);
  });

  it('groups each label with the control it names', async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    const dialog = root.querySelector('[role="dialog"]')!;
    for (const [label, sel] of [
      ['Name', 'input.input'],
      ['Start from', '[data-testid="preset-row"]'],
      ['Definition', '.json-editor-stub'],
    ] as [string, string][]) {
      const labelEl = [...dialog.querySelectorAll('.' + mstyles.fieldLabel)].find(
        (n) => n.textContent === label,
      )!;
      const field = labelEl.closest('.' + mstyles.field)!;
      expect(field).not.toBeNull();
      expect(field.querySelector(sel)).not.toBeNull();
      // Only the editor's field may absorb the card's spare height. Without it the
      // group cannot shrink and the editor grows the card — the shift this modal
      // was fixed for. Nothing in jsdom would notice, so assert the opt-in.
      expect(field.classList.contains(mstyles.fieldGrow)).toBe(label === 'Definition');
    }
  });

  it("hands the editor its height rather than taking the editor's", async () => {
    const root = mount();
    await Promise.resolve();
    await openCreate(root);
    // `fill` is what stops the editor growing with the definition — the search
    // presets are long enough that it grew 250→509px and took the card with it.
    expect(root.querySelector('.json-editor-stub')!.getAttribute('data-fill')).toBe('1');
  });
});
