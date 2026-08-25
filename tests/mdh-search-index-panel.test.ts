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
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({ default: () => h('div', { class: 'json-editor-stub' }) }));

import * as api from '../src/mdh/api.js';
import SearchIndexPanel from '../src/mdh/components/SearchIndexPanel.jsx';
import { selectedCollection, activePanel, loading, error } from '../src/mdh/store.js';

const writeText = vi.fn().mockResolvedValue(undefined);

// A real listed index (snake_case, nested under latest_definition, + runtime).
function listedIndex(overrides = {}) {
  return {
    name: 'default',
    type: 'search',
    status: 'READY',
    queryable: true,
    latest_definition: {
      mappings: { dynamic: false, fields: { NAME: { type: 'string' } } },
      analyzer: null,
      analyzers: null,
      search_analyzer: null,
      synonyms: null,
    },
    ...overrides,
  };
}

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(SearchIndexPanel, null), root);
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

describe('SearchIndexPanel — copy is create-ready', () => {
  it('Copy puts the clean { indexName, mappings } definition on the clipboard', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [listedIndex()] });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    const expected = JSON.stringify(
      { indexName: 'default', mappings: { dynamic: false, fields: { NAME: { type: 'string' } } } },
      null, 2,
    );
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  it('copied JSON carries no runtime fields or latest_definition wrapper', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [listedIndex()] });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    root.querySelector<HTMLElement>('.action-copy')!.click();

    // Assert on parsed top-level keys: mappings legitimately nests its own
    // "type" specs, so a substring check would false-positive.
    const parsed = JSON.parse(writeText.mock.calls[0][0]);
    expect(parsed).not.toHaveProperty('latest_definition');
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('queryable');
    expect(parsed).not.toHaveProperty('type');
    expect(parsed).not.toHaveProperty('name');
    expect(parsed).toHaveProperty('indexName', 'default');
  });
});

describe('SearchIndexPanel — runtime state is in badges, not JSON', () => {
  function badgeTexts(root: any) {
    return [...root.querySelectorAll('.index-badge')].map((b) => b.textContent.toLowerCase());
  }

  it('shows a "not queryable" badge when queryable is false', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [listedIndex({ queryable: false })] });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    expect(badgeTexts(root).some((t) => t.includes('not queryable'))).toBe(true);
  });

  it('does not show a queryable badge when queryable is true', async () => {
    vi.mocked(api.listSearchIndexes).mockResolvedValue({ result: [listedIndex({ queryable: true })] });
    const root = mount();

    await vi.waitFor(() => expect(root.querySelector('.action-copy')).not.toBeNull());
    expect(badgeTexts(root).some((t) => t.includes('queryable'))).toBe(false);
  });
});
