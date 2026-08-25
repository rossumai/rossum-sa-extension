import { describe, it, expect } from 'vitest';
import { toCreateSearchIndexDefinition } from '../src/mdh/searchIndexDef.js';

// The six fields the Create Search Index modal parses / api.createSearchIndex sends.
const CREATE_FIELDS = [
  'indexName',
  'mappings',
  'analyzer',
  'analyzers',
  'searchAnalyzer',
  'synonyms',
];

describe('toCreateSearchIndexDefinition', () => {
  it('turns the real listed sample into a clean, create-ready definition', () => {
    // Verbatim from a live /search_indexes/list response (nameOnly=false).
    const listed = {
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
    };

    expect(toCreateSearchIndexDefinition(listed)).toEqual({
      indexName: 'default',
      mappings: { dynamic: false, fields: { NAME: { type: 'string' } } },
    });
  });

  it('drops runtime fields and the latest_definition wrapper', () => {
    const out = toCreateSearchIndexDefinition({
      name: 'x',
      type: 'search',
      status: 'READY',
      queryable: true,
      latest_definition: { mappings: { dynamic: true } },
    });
    expect(out).not.toHaveProperty('type');
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('queryable');
    expect(out).not.toHaveProperty('latest_definition');
    expect(out).not.toHaveProperty('name');
  });

  it('lifts all optionals and renames search_analyzer to searchAnalyzer', () => {
    const listed = {
      name: 'rich',
      type: 'search',
      status: 'READY',
      queryable: true,
      latest_definition: {
        mappings: { dynamic: true },
        analyzer: 'lucene.standard',
        analyzers: [{ name: 'custom', tokenizer: { type: 'standard' } }],
        search_analyzer: 'lucene.keyword',
        synonyms: [{ name: 'syns', source: { collection: 'thes' }, analyzer: 'lucene.standard' }],
      },
    };

    expect(toCreateSearchIndexDefinition(listed)).toEqual({
      indexName: 'rich',
      mappings: { dynamic: true },
      analyzer: 'lucene.standard',
      analyzers: [{ name: 'custom', tokenizer: { type: 'standard' } }],
      searchAnalyzer: 'lucene.keyword',
      synonyms: [{ name: 'syns', source: { collection: 'thes' }, analyzer: 'lucene.standard' }],
    });
  });

  it('omits null/absent optionals entirely', () => {
    const out = toCreateSearchIndexDefinition({
      name: 'y',
      latest_definition: {
        mappings: { dynamic: true },
        analyzer: null,
        analyzers: null,
        search_analyzer: null,
        synonyms: null,
      },
    });
    expect(Object.keys(out).sort()).toEqual(['indexName', 'mappings']);
  });

  it('tolerates a missing latest_definition without crashing', () => {
    expect(toCreateSearchIndexDefinition({ name: 'orphan' })).toEqual({ indexName: 'orphan' });
  });

  it('returns non-object input unchanged', () => {
    expect(toCreateSearchIndexDefinition(null)).toBe(null);
    expect(toCreateSearchIndexDefinition('foo')).toBe('foo');
  });

  it('never emits a key outside the create contract', () => {
    const listed = {
      name: 'z',
      type: 'search',
      status: 'FAILED',
      queryable: false,
      id: 'abc123',
      someFutureRuntimeField: 42,
      latest_definition: {
        mappings: { dynamic: true },
        search_analyzer: 'lucene.keyword',
        unknownNested: 'ignored',
      },
    };
    const out = toCreateSearchIndexDefinition(listed);
    for (const key of Object.keys(out)) {
      expect(CREATE_FIELDS).toContain(key);
    }
  });
});
