import { describe, it, expect } from 'vitest';
import {
  configUsesLineItems,
  flattenContent,
  rowScopeForConfig,
} from '../src/popup/mdh-provenance.js';

// The fixture mirrors a LIVE annotation (elis, queue 4002271, annotation
// 141187280, verified 2026-08-10): the SAME annotation carries `tax_details`
// with 1 row and `line_items` with 5. That combination is the whole bug — a
// config whose target lives in the 1-row table used to be offered 5 rows,
// because `rowCount` was the MAX across every table in the document.
//
// Also live-verified the same day: `GET /annotations/{id}/content?schema_id=…`
// IGNORES the filter (a bogus id still returns all 96 fields; `results` is a
// duplicate of `content`), so the panel always sees EVERY table — which is why
// the target field's own table can always be located without another request.
const dp = (schemaId, value) => ({
  schema_id: schemaId,
  category: 'datapoint',
  content: { value, normalized_value: null },
});

const tuple = (columns) => ({ category: 'tuple', schema_id: 'row', children: columns });

const twoTableContent = () => ({
  content: [
    {
      category: 'section',
      schema_id: 'totals_section',
      children: [
        dp('amount_total', '120.00'),
        {
          category: 'multivalue',
          schema_id: 'tax_details',
          id: 20026521847,
          children: [
            tuple([dp('tax_detail_rate', '21'), dp('tax_code_matched', 'S1')]),
          ],
        },
      ],
    },
    {
      category: 'section',
      schema_id: 'line_items_section',
      children: [
        {
          category: 'multivalue',
          schema_id: 'line_items',
          id: 20026521848,
          children: Array.from({ length: 5 }, (_, i) => tuple([
            dp('item_description', `ITEM-${i}`),
            dp('item_tax_code_match', ''),
          ])),
        },
      ],
    },
  ],
});

// ── flattenContent: per-table grouping ────────────────

describe('flattenContent — per-table row grouping', () => {
  it('reports each table separately instead of only the maximum row count', () => {
    const flat = flattenContent(twoTableContent());
    expect(flat.tables).toEqual([
      {
        schemaId: 'tax_details',
        rowCount: 1,
        columns: ['tax_detail_rate', 'tax_code_matched'],
      },
      {
        schemaId: 'line_items',
        rowCount: 5,
        columns: ['item_description', 'item_tax_code_match'],
      },
    ]);
  });

  it('keeps the flat rowValues map and the global rowCount for existing callers', () => {
    const flat = flattenContent(twoTableContent());
    expect(flat.rowCount).toBe(5);
    expect(flat.rowValues.tax_detail_rate).toEqual(['21']);
    expect(flat.rowValues.item_description).toHaveLength(5);
  });

  it('returns an empty tables list for a document with no tables', () => {
    const flat = flattenContent({ content: [dp('document_id', '1')] });
    expect(flat.tables).toEqual([]);
  });

  it('records a table that exists but has no rows yet', () => {
    const flat = flattenContent({
      content: [{ category: 'multivalue', schema_id: 'tax_details', children: [] }],
    });
    expect(flat.tables).toEqual([{ schemaId: 'tax_details', rowCount: 0, columns: [] }]);
  });
});

// ── rowScopeForConfig: the target field's table governs ─

describe('rowScopeForConfig', () => {
  const tables = () => flattenContent(twoTableContent()).tables;

  it('scopes to the table holding the target field, not the biggest table', () => {
    const cfg = {
      target: 'tax_code_matched',
      queries: [{ placeholders: ['tax_detail_rate'] }],
    };
    expect(rowScopeForConfig(cfg, tables())).toEqual({
      tableSchemaId: 'tax_details',
      rowCount: 1,
    });
  });

  it('scopes a line-item target to the line-items table', () => {
    const cfg = {
      target: 'item_tax_code_match',
      queries: [{ placeholders: ['item_description'] }],
    };
    expect(rowScopeForConfig(cfg, tables())).toEqual({
      tableSchemaId: 'line_items',
      rowCount: 5,
    });
  });

  it('ignores the other table even when the query mixes tables', () => {
    const cfg = {
      target: 'tax_code_matched',
      queries: [{ placeholders: ['tax_detail_rate', 'item_description'] }],
    };
    expect(rowScopeForConfig(cfg, tables()).tableSchemaId).toBe('tax_details');
  });

  it('falls back to the row placeholders table when the target is a header field', () => {
    const cfg = {
      target: 'tax_code_match_header',
      queries: [{ placeholders: ['item_description'] }],
    };
    expect(rowScopeForConfig(cfg, tables())).toEqual({
      tableSchemaId: 'line_items',
      rowCount: 5,
    });
  });

  it('falls back using an action_condition placeholder when no query has one', () => {
    const cfg = {
      target: 'header_target',
      queries: [{ placeholders: [] }],
      actionConditionPlaceholders: ['tax_detail_rate'],
    };
    expect(rowScopeForConfig(cfg, tables()).tableSchemaId).toBe('tax_details');
  });

  it('returns null when nothing about the config is row-scoped', () => {
    const cfg = { target: 'sender_name', queries: [{ placeholders: ['sender_ic'] }] };
    expect(rowScopeForConfig(cfg, tables())).toBeNull();
  });

  it('prefers the table contributing the most placeholders when the target is header-level', () => {
    const cfg = {
      target: 'header_target',
      queries: [{ placeholders: ['item_description', 'item_tax_code_match', 'tax_detail_rate'] }],
    };
    expect(rowScopeForConfig(cfg, tables()).tableSchemaId).toBe('line_items');
  });

  it('tolerates a missing or unusable tables list', () => {
    const cfg = { target: 'tax_code_matched', queries: [{ placeholders: ['tax_detail_rate'] }] };
    expect(rowScopeForConfig(cfg, undefined)).toBeNull();
    expect(rowScopeForConfig(cfg, [])).toBeNull();
  });

  it('does not treat the "(no target)" placeholder label as a real field', () => {
    const cfg = {
      target: '(no target)',
      queries: [{ placeholders: ['item_description'] }],
    };
    expect(rowScopeForConfig(cfg, tables()).tableSchemaId).toBe('line_items');
  });
});

// ── configUsesLineItems: the action_condition counts too ─

describe('configUsesLineItems — action_condition placeholders', () => {
  it('treats a row-level action_condition placeholder as row usage', () => {
    const rowValues = { tax_detail_rate: ['21'] };
    const cfg = {
      queries: [{ placeholders: ['sender_ic'] }],
      actionConditionPlaceholders: ['tax_detail_rate'],
    };
    // The condition is already evaluated per row by evaluateCfgCondition, so a
    // config gated on a row field must get a picker — otherwise it is silently
    // judged against row 0 only.
    expect(configUsesLineItems(cfg, rowValues)).toBe(true);
  });

  it('still returns false when neither queries nor the condition use a row field', () => {
    const cfg = {
      queries: [{ placeholders: ['sender_ic'] }],
      actionConditionPlaceholders: ['currency'],
    };
    expect(configUsesLineItems(cfg, { tax_detail_rate: ['21'] })).toBe(false);
  });

  it('tolerates a config with no actionConditionPlaceholders field', () => {
    const cfg = { queries: [{ placeholders: ['tax_detail_rate'] }] };
    expect(configUsesLineItems(cfg, { tax_detail_rate: ['21'] })).toBe(true);
  });
});
