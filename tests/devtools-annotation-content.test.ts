import { describe, it, expect } from 'vitest';
import {
  isAnnotationContentPath,
  forEditing,
  changedTables,
} from '../src/devtools/annotationContent.js';

const row = (id: number | undefined, value: string) => ({
  id,
  category: 'tuple',
  schema_id: 'line_item',
  children: [{ id: id == null ? undefined : id * 10, category: 'datapoint', content: { value } }],
});
const doc = (rows: any[]) => ({
  content: [
    {
      id: 1,
      category: 'section',
      schema_id: 'items_section',
      children: [{ id: 2, category: 'multivalue', schema_id: 'line_items', children: rows }],
    },
  ],
});

describe('isAnnotationContentPath', () => {
  it("matches only an annotation's whole content", () => {
    expect(isAnnotationContentPath('/api/v1/annotations/12/content')).toBe(true);
    expect(isAnnotationContentPath('/api/v1/annotations/12/content/99')).toBe(false);
    expect(isAnnotationContentPath('/api/v1/documents/12/content')).toBe(false);
    expect(isAnnotationContentPath(undefined)).toBe(false);
  });
});

describe('forEditing', () => {
  it('drops the duplicate `results` tree and keeps everything else', () => {
    expect(forEditing({ content: [1], results: [1], extra: true })).toEqual({
      content: [1],
      extra: true,
    });
  });

  it('leaves a body without a content array alone', () => {
    const body = { results: [1] };
    expect(forEditing(body)).toBe(body);
    expect(forEditing(null)).toBeNull();
  });
});

describe('changedTables', () => {
  const original = doc([row(3, 'a'), row(4, 'b')]);

  it('is empty when only values changed', () => {
    expect(changedTables(original, doc([row(3, 'x'), row(4, 'y')]))).toEqual([]);
  });

  it('names a table whose rows were removed or moved', () => {
    expect(changedTables(original, doc([row(4, 'b')]))).toEqual(['line_items']);
    expect(changedTables(original, doc([row(4, 'b'), row(3, 'a')]))).toEqual(['line_items']);
  });

  it('names a table where a new row was inserted before an existing one (it shifts them)', () => {
    const inserted = doc([row(3, 'a'), row(undefined, 'new'), row(4, 'b')]);
    expect(changedTables(original, inserted)).toEqual(['line_items']);
  });

  it('does not warn for new rows appended after every existing one', () => {
    const appended = doc([row(3, 'a'), row(4, 'b'), row(undefined, 'c'), row(undefined, 'd')]);
    expect(changedTables(original, appended)).toEqual([]);
  });

  it('ignores a table left out of the payload, which keeps its rows', () => {
    expect(changedTables(original, { content: [] })).toEqual([]);
  });
});
