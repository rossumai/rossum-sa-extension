// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import { downloadCollection, buildXlsxSerializer } from '../src/mdh/downloadCollection.js';
import { parseXlsx } from '../src/mdh/xlsx.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('xlsx streamed export via the download engine', () => {
  it('streams an xlsx (Blob fallback) that round-trips through the reader', async () => {
    const docs = [
      { name: 'Alice', n: 1, joined: { $date: '2024-01-01T00:00:00.000Z' } },
      { name: 'Bob', n: 2, joined: { $date: '2024-01-15T00:00:00.000Z' } },
    ];
    api.aggregate.mockResolvedValue({ result: docs });

    let blob = null;
    const res = await downloadCollection('c', {
      serializer: buildXlsxSerializer({ sheetName: 'c', columns: ['name', 'n', 'joined'] }),
      fetchCount: async () => 2,
      pickFile: async () => null,          // force the Blob fallback
      downloadBlob: (b) => { blob = b; },
    });

    expect(res.cancelled).toBe(false);
    expect(res.fetched).toBe(2);
    expect(blob).not.toBeNull();
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const buf = await blob.arrayBuffer();
    const { docs: back, columns, error } = await parseXlsx(buf, { hasHeader: true, emptyMode: 'omit' });
    expect(error).toBe(null);
    expect(columns).toEqual(['name', 'n', 'joined']);
    expect(back).toEqual(docs);
  });

  it('discovers columns from the collection when none are supplied', async () => {
    api.aggregate.mockImplementation(async (col, pipeline) => {
      const last = pipeline[pipeline.length - 1];
      if (last && last.$facet) return { result: [{ f0: [{ _id: '_id', types: ['objectId'] }, { _id: 'name', types: ['string'] }] }] };
      return { result: [{ _id: 'V1', name: 'x' }] };
    });
    let blob = null;
    await downloadCollection('c', {
      serializer: buildXlsxSerializer({ sheetName: 'c' }),
      fetchCount: async () => 1,
      pickFile: async () => null,
      downloadBlob: (b) => { blob = b; },
    });
    const { columns } = await parseXlsx(await blob.arrayBuffer(), { hasHeader: true });
    expect(columns).toEqual(['_id', 'name']); // orderColumns puts _id first
  });
});
