import { describe, it, expect } from 'vitest';
import {
  toSearchIndexDefinition,
  statusBadge,
  isTransitional,
  syncSummary,
  summarizeDefinition,
  splitPastedDefinition,
  firstValidationLine,
} from '../src/mdh/searchIndexDef.js';

describe('toSearchIndexDefinition', () => {
  it('returns the definition object untouched — V2 already hands back create-ready input', () => {
    const definition = { mappings: { dynamic: false, fields: { name: { type: 'string' } } } };
    expect(
      toSearchIndexDefinition({ name: 'x', definition, status: 'READY', queryable: true }),
    ).toBe(definition);
  });

  it('passes an engine-only camelCase definition through unchanged', () => {
    // An index that exists on the engine with no registry declaration comes back
    // in the engine's own casing. V2 accepts both casings on input, so nothing
    // is renamed — this is the population that predates the re-host.
    const definition = {
      mappings: { dynamic: true },
      searchAnalyzer: 'lucene.standard',
      analyzers: [{ name: 'a', tokenizer: { type: 'whitespace' }, tokenFilters: [] }],
    };
    expect(toSearchIndexDefinition({ name: 'y', definition })).toBe(definition);
  });

  it('returns an empty object rather than throwing on junk', () => {
    expect(toSearchIndexDefinition(null)).toEqual({});
    expect(toSearchIndexDefinition('nope')).toEqual({});
    expect(toSearchIndexDefinition({ name: 'no-definition' })).toEqual({});
  });
});

describe('statusBadge', () => {
  it('maps READY to the ready class and renders it lowercase', () => {
    expect(statusBadge('READY')).toEqual({
      text: 'ready',
      cls: 'index-badge-ready',
      title: 'Built and queryable',
    });
  });

  it('renders the API value with underscores as spaces', () => {
    expect(statusBadge('PENDING_CREATE')!.text).toBe('pending create');
    expect(statusBadge('PENDING_UPDATE')!.text).toBe('pending update');
    expect(statusBadge('PENDING_DELETE')!.text).toBe('pending delete');
  });

  it('gives every transitional status the pending class and an explanatory title', () => {
    for (const s of [
      'PENDING_CREATE',
      'PENDING_UPDATE',
      'PENDING_DELETE',
      'PENDING',
      'BUILDING',
      'DELETING',
    ]) {
      const badge = statusBadge(s)!;
      expect(badge.cls).toBe('index-badge-pending');
      expect(badge.title.length).toBeGreaterThan(0);
    }
  });

  it('treats FAILED and STALE as failed', () => {
    expect(statusBadge('FAILED')!.cls).toBe('index-badge-failed');
    expect(statusBadge('STALE')!.cls).toBe('index-badge-failed');
  });

  it('renders an unrecognised status neutrally rather than guessing', () => {
    const badge = statusBadge('SOMETHING_NEW')!;
    expect(badge.text).toBe('something new');
    expect(badge.cls).toBe('');
    expect(badge.title).toBe('');
  });

  it('returns null when there is no status', () => {
    expect(statusBadge(undefined)).toBeNull();
    expect(statusBadge('')).toBeNull();
  });
});

describe('isTransitional', () => {
  it('is true for every registry-ahead and engine-working status', () => {
    for (const s of [
      'PENDING_CREATE',
      'PENDING_UPDATE',
      'PENDING_DELETE',
      'PENDING',
      'BUILDING',
      'DELETING',
    ]) {
      expect(isTransitional(s)).toBe(true);
    }
  });

  it('is false for terminal statuses and for anything unrecognised', () => {
    for (const s of ['READY', 'FAILED', 'STALE', 'SOMETHING_NEW', '', null, undefined]) {
      expect(isTransitional(s)).toBe(false);
    }
  });
});

describe('syncSummary', () => {
  const now = Date.now();

  it('says there are no indexes', () => {
    expect(syncSummary([], now).text).toBe('no indexes');
  });

  it('reports everything settled', () => {
    const out = syncSummary([{ status: 'READY' }, { status: 'FAILED' }], now);
    expect(out.text).toContain('2 indexes');
    expect(out.text).toContain('in sync');
    expect(out.working).toBe(false);
  });

  it('counts what is still moving', () => {
    const out = syncSummary(
      [{ status: 'READY' }, { status: 'BUILDING' }, { status: 'PENDING_DELETE' }],
      now,
    );
    expect(out.text).toContain('3 indexes');
    expect(out.text).toContain('2 in progress');
    expect(out.working).toBe(true);
  });

  it('uses the singular for one index', () => {
    expect(syncSummary([{ status: 'READY' }], now).text).toContain('1 index ·');
  });

  it('carries when it last looked', () => {
    expect(syncSummary([{ status: 'READY' }], now).text).toContain('checked just now');
  });

  it('omits the timestamp when it has never looked', () => {
    expect(syncSummary([{ status: 'READY' }], null).text).not.toContain('checked');
  });
});

describe('summarizeDefinition', () => {
  it('says all fields for a purely dynamic mapping', () => {
    expect(summarizeDefinition({ mappings: { dynamic: true } })).toBe('dynamic — all fields');
  });

  it('counts explicit fields alongside a dynamic mapping', () => {
    expect(summarizeDefinition({ mappings: { dynamic: true, fields: { a: {}, b: {} } } })).toBe(
      'dynamic + 2 fields',
    );
  });

  it('names a single field in the singular', () => {
    expect(summarizeDefinition({ mappings: { dynamic: false, fields: { name: {} } } })).toBe(
      '1 field: name',
    );
  });

  it('names up to three fields and elides the rest', () => {
    expect(
      summarizeDefinition({ mappings: { dynamic: false, fields: { a: {}, b: {}, c: {}, d: {} } } }),
    ).toBe('4 fields: a, b, c…');
  });

  it('names exactly three without an ellipsis', () => {
    expect(
      summarizeDefinition({ mappings: { dynamic: false, fields: { a: {}, b: {}, c: {} } } }),
    ).toBe('3 fields: a, b, c');
  });

  it('returns an empty string when there is nothing to say', () => {
    expect(summarizeDefinition({})).toBe('');
    expect(summarizeDefinition(null)).toBe('');
    expect(summarizeDefinition({ mappings: { dynamic: false } })).toBe('');
  });
});

describe('splitPastedDefinition', () => {
  it('lifts a legacy indexName out of the body — V2 rejects it as an extra key', () => {
    expect(splitPastedDefinition({ indexName: 'by_name', mappings: { dynamic: true } })).toEqual({
      name: 'by_name',
      definition: { mappings: { dynamic: true } },
    });
  });

  it('lifts a name key the same way', () => {
    expect(splitPastedDefinition({ name: 'by_name', mappings: { dynamic: true } })).toEqual({
      name: 'by_name',
      definition: { mappings: { dynamic: true } },
    });
  });

  it('leaves a plain definition alone, object identity included', () => {
    const parsed = { mappings: { dynamic: true }, storedSource: { include: ['a'] } };
    const out = splitPastedDefinition(parsed);
    expect(out.name).toBeNull();
    expect(out.definition).toBe(parsed);
  });

  it('ignores a non-string name rather than lifting nonsense', () => {
    const parsed = { name: 42, mappings: { dynamic: true } };
    expect(splitPastedDefinition(parsed).name).toBeNull();
  });

  it('returns the input untouched when it is not an object', () => {
    expect(splitPastedDefinition(null)).toEqual({ name: null, definition: null });
    expect(splitPastedDefinition([1])).toEqual({ name: null, definition: [1] });
  });
});

describe('firstValidationLine', () => {
  // One unsupported mapping type produces one error per union branch plus the
  // top level — eight near-identical Python reprs. The first is representative.
  const eight =
    "8 validation errors:\n  {'type': 'literal_error', 'loc': ('body', 'mappings', 'fields', " +
    "'_id', 'StringFieldMapping', 'type'), 'msg': \"Input should be 'string'\"}\n" +
    "  {'type': 'literal_error', 'loc': ('body', 'x'), 'msg': 'two'}\n" +
    "  {'type': 'literal_error', 'loc': ('body', 'y'), 'msg': 'three'}";

  it('keeps only the first of many union-branch errors', () => {
    const out = firstValidationLine(eight);
    expect(out).toContain('8 validation errors');
    expect(out).toContain("Input should be 'string'");
    expect(out).not.toContain('two');
    expect(out).not.toContain('three');
  });

  it('returns a single-error message whole', () => {
    const one = "1 validation error:\n  {'type': 'extra_forbidden', 'loc': ('body', 'indexName')}";
    expect(firstValidationLine(one)).toBe(one);
  });

  it('returns a message that is not shaped like a validation list unchanged', () => {
    expect(firstValidationLine("Dataset 'x' not found")).toBe("Dataset 'x' not found");
  });

  it('tolerates a non-string', () => {
    expect(firstValidationLine(undefined)).toBe('');
    expect(firstValidationLine(null)).toBe('');
  });
});
