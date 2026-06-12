// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { init as initSchemaIds, handleNode as handleSchemaId } from '../src/rossum/features/schema-ids.js';
import { handleNode as handleExpandFormulas } from '../src/rossum/features/expand-formulas.js';
import { handleNode as handleExpandReasoning } from '../src/rossum/features/expand-reasoning.js';

describe('schema-ids', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('init injects CSS into head', () => {
    initSchemaIds();
    const style = document.head.querySelector('style');
    expect(style).not.toBeNull();
    expect(style.textContent).toContain('rossum-sa-extension-schema-id');
  });

  it('handleNode adds ID badge to annotated elements', () => {
    const el = document.createElement('div');
    el.setAttribute('data-sa-extension-schema-id', '12345');
    document.body.appendChild(el);

    handleSchemaId(el);

    const badge = el.querySelector('.rossum-sa-extension-schema-id');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('12345');
  });

  it('handleNode ignores elements without the attribute', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    handleSchemaId(el);

    expect(el.querySelector('.rossum-sa-extension-schema-id')).toBeNull();
  });
});

describe('expand-formulas', () => {
  it('auto-clicks "Show source code" buttons inside a container', () => {
    const container = document.createElement('div');
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Show source code');
    container.appendChild(button);
    const spy = vi.spyOn(button, 'click');

    handleExpandFormulas(container);

    expect(spy).toHaveBeenCalledOnce();
  });

  it('auto-clicks when the button itself is the node', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Show source code');
    const spy = vi.spyOn(button, 'click');

    handleExpandFormulas(button);

    expect(spy).toHaveBeenCalledOnce();
  });

  it('ignores unrelated buttons', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Save');
    const spy = vi.spyOn(button, 'click');

    handleExpandFormulas(button);

    expect(spy).not.toHaveBeenCalled();
  });

  it('clicks each button only once even when handleNode runs again', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Show source code');
    const spy = vi.spyOn(button, 'click');

    handleExpandFormulas(button);
    handleExpandFormulas(button);

    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('expand-reasoning', () => {
  it('auto-clicks reasoning "Show options" buttons', () => {
    const container = document.createElement('div');
    const button = document.createElement('button');
    button.setAttribute('data-sentry-source-file', 'ReasoningTiles.tsx');
    button.textContent = 'Show options';
    container.appendChild(button);
    const spy = vi.spyOn(button, 'click');

    handleExpandReasoning(container);

    expect(spy).toHaveBeenCalledOnce();
  });

  it('ignores reasoning buttons with different text', () => {
    const button = document.createElement('button');
    button.setAttribute('data-sentry-source-file', 'ReasoningTiles.tsx');
    button.textContent = 'Hide options';
    const spy = vi.spyOn(button, 'click');

    handleExpandReasoning(button);

    expect(spy).not.toHaveBeenCalled();
  });

  it('clicks each reasoning button only once even when handleNode runs again', () => {
    const button = document.createElement('button');
    button.setAttribute('data-sentry-source-file', 'ReasoningTiles.tsx');
    button.textContent = 'Show options';
    const spy = vi.spyOn(button, 'click');

    handleExpandReasoning(button);
    handleExpandReasoning(button);

    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('resource-ids', () => {
  let handleNode, init;

  beforeEach(async () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.resetModules();

    // Mock the API module so importing resource-ids doesn't trigger real fetches
    vi.doMock('../src/rossum/api.js', () => ({
      fetchRossumApi: vi.fn().mockResolvedValue({ results: [] }),
    }));

    const mod = await import('../src/rossum/features/resource-ids.js');
    handleNode = mod.handleNode;
    init = mod.init;
    init();
  });

  it('displays ID for sidebar queue (data-id attribute)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-cy', 'sidebar-queue');
    el.dataset.id = '789';
    document.body.appendChild(el);

    handleNode(el);

    const badge = el.querySelector('.rossum-sa-extension-resource-id');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('789');
    expect(badge.title).toBe('Click to copy');
  });

  it('displays ID for queue link (extracted from href)', () => {
    const el = document.createElement('a');
    el.setAttribute('data-cy', 'queue');
    el.setAttribute('href', '/queues/456/settings');
    document.body.appendChild(el);

    handleNode(el);

    const badge = el.querySelector('.rossum-sa-extension-resource-id');
    expect(badge.textContent).toBe('456');
  });

  it('displays ID for rule tile (data-id attribute)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-cy', 'rule-tile');
    el.dataset.id = '101';
    document.body.appendChild(el);

    handleNode(el);

    const badge = el.querySelector('.rossum-sa-extension-resource-id');
    expect(badge.textContent).toBe('101');
  });

  it('displays ID for AI engine tile (data-id attribute)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-cy', 'engine-tile');
    el.dataset.id = '777';
    document.body.appendChild(el);

    handleNode(el);

    const badge = el.querySelector('.rossum-sa-extension-resource-id');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('777');
  });

  it('ignores engine tiles without data-id (dedicated/generic engines)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-cy', 'engine-tile');
    document.body.appendChild(el);

    handleNode(el);

    expect(el.querySelector('.rossum-sa-extension-resource-id')).toBeNull();
  });

  it('displays ID for extension name (extracted from parent href)', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/extensions/my-extensions/333');
    const el = document.createElement('span');
    el.setAttribute('data-cy', 'extensions-list-name');
    anchor.appendChild(el);
    document.body.appendChild(anchor);

    handleNode(el);

    const badge = el.querySelector('.rossum-sa-extension-resource-id');
    expect(badge.textContent).toBe('333');
    expect(badge.classList.contains('rossum-sa-extension-resource-id--left-offset')).toBe(true);
  });

  it('displays ID for user name (extracted from parent href)', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/settings/users/555');
    const el = document.createElement('span');
    el.setAttribute('data-field', 'name');
    anchor.appendChild(el);
    document.body.appendChild(anchor);

    handleNode(el);

    const badge = el.querySelector('.rossum-sa-extension-resource-id');
    expect(badge.textContent).toBe('555');
  });

  it('displays annotation ID from parent document row', () => {
    const row = document.createElement('tr');
    row.setAttribute('data-cy', 'document-row');
    row.dataset.id = '9999';
    const cell = document.createElement('td');
    cell.setAttribute('data-field', 'original_file_name');
    row.appendChild(cell);
    document.body.appendChild(row);

    handleNode(cell);

    const badge = cell.querySelector('.rossum-sa-extension-resource-id');
    expect(badge.textContent).toBe('9999');
  });

  it('does not duplicate badges when called twice', () => {
    const el = document.createElement('div');
    el.setAttribute('data-cy', 'sidebar-queue');
    el.dataset.id = '789';
    document.body.appendChild(el);

    handleNode(el);
    handleNode(el);

    expect(el.querySelectorAll('.rossum-sa-extension-resource-id')).toHaveLength(1);
  });
});

describe('resource-ids labels', () => {
  let handleNode, init;

  // Mirrors the real Settings > Labels DOM: a TileContent tile wrapping a
  // LabelChip whose name lives in a `.MuiChip-label` span.
  function labelTile(name) {
    const tile = document.createElement('div');
    tile.setAttribute('data-sentry-component', 'TileContent');
    const chip = document.createElement('div');
    chip.setAttribute('data-sentry-component', 'LabelChip');
    const label = document.createElement('span');
    label.className = 'MuiChip-label';
    label.textContent = name;
    chip.appendChild(label);
    tile.appendChild(chip);
    document.body.appendChild(tile);
    return chip;
  }

  // A LabelChip outside the management list (e.g. a label assigned to a document
  // row) — no TileContent ancestor.
  function looseChip(name) {
    const chip = document.createElement('div');
    chip.setAttribute('data-sentry-component', 'LabelChip');
    const label = document.createElement('span');
    label.className = 'MuiChip-label';
    label.textContent = name;
    chip.appendChild(label);
    document.body.appendChild(chip);
    return chip;
  }

  function badge(chip) {
    return chip.querySelector('.rossum-sa-extension-resource-id')?.textContent;
  }

  // The labels endpoint returns results ordered by name, so a same-named group
  // appears in the same order the list renders it.
  const LABELS = {
    results: [
      { id: 9931, name: 'Audit hold' },
      { id: 9920, name: 'Trial vendor' },
      { id: 11492, name: 'Trial vendor' },
    ],
  };

  beforeEach(async () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.resetModules();
    vi.doMock('../src/rossum/api.js', () => ({
      fetchRossumApi: vi.fn().mockResolvedValue(LABELS),
    }));
    const mod = await import('../src/rossum/features/resource-ids.js');
    handleNode = mod.handleNode;
    init = mod.init;
    init();
  });

  it('gives two same-named labels their own distinct IDs', async () => {
    const first = labelTile('Trial vendor');
    const second = labelTile('Trial vendor');

    handleNode(first);
    handleNode(second);

    await vi.waitFor(() => {
      expect(badge(first)).toBeDefined();
      expect(badge(second)).toBeDefined();
    });

    // Nth same-named tile -> Nth same-named label, in list/API order.
    expect(badge(first)).toBe('9920');
    expect(badge(second)).toBe('11492');
  });

  it('shows the single ID for a unique label name', async () => {
    const chip = labelTile('Audit hold');

    handleNode(chip);

    await vi.waitFor(() => expect(badge(chip)).toBeDefined());
    expect(badge(chip)).toBe('9931');
  });

  it('does not positionally disambiguate chips outside the management list', async () => {
    // Two document-row chips for the same label name must NOT be treated as two
    // different labels — only a subset of chips is present there, so positional
    // mapping is meaningless. Both keep the first-match id (unchanged behaviour).
    const a = looseChip('Trial vendor');
    const b = looseChip('Trial vendor');

    handleNode(a);
    handleNode(b);

    await vi.waitFor(() => {
      expect(badge(a)).toBeDefined();
      expect(badge(b)).toBeDefined();
    });

    expect(badge(a)).toBe('9920');
    expect(badge(b)).toBe('9920');
  });
});
