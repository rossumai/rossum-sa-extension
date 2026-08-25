// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
import {
  EXPORT_FORMATS,
  getExportFormat,
  exportFilename,
  buildExportJob,
} from '../src/mdh/exportFormats.jsx';
import * as api from '../src/mdh/api.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('export format registry', () => {
  it('lists the five formats in menu order with the right extensions', () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(['json', 'jsonl', 'csv', 'xlsx', 'xml']);
    expect(EXPORT_FORMATS.map((f) => f.ext)).toEqual(['json', 'jsonl', 'csv', 'xlsx', 'xml']);
    expect(EXPORT_FORMATS.map((f) => f.needsColumns)).toEqual([false, false, true, true, false]);
  });

  it('builds serializers with options passed through (incl. the CSV BOM flag)', () => {
    const csv = getExportFormat('csv')!.buildSerializer(
      { delimiter: ';', header: false, bom: true },
      ['sku', 'price'],
    );
    expect(csv.ext).toBe('csv');
    expect(csv.preamble()).toBe('\uFEFF'); // BOM on, header off
    const noBom = getExportFormat('csv')!.buildSerializer(
      { delimiter: ',', header: true, bom: false },
      ['sku'],
    );
    expect(noBom.preamble()).toBe('sku\r\n'); // no BOM (today's default), header on
    expect(
      getExportFormat('xml')!.buildSerializer({ rootName: 'rows', recordName: 'row' }).preamble(),
    ).toContain('<rows>');
    expect(getExportFormat('json')!.buildSerializer({}).ext).toBe('json');
    expect(getExportFormat('jsonl')!.buildSerializer({}).ext).toBe('jsonl');
    expect(
      getExportFormat('xlsx')!.buildSerializer({ sheetName: 'S', header: true }, ['sku']).binary,
    ).toBe(true);
  });

  it('builds preview text per format', () => {
    const sample = [{ sku: 'A', price: 1 }];
    expect(getExportFormat('jsonl')!.buildPreviewText!(sample, null, {})).toBe(
      '{"sku":"A","price":1}',
    );
    expect(getExportFormat('json')!.buildPreviewText!(sample, null, {})).toContain('"sku": "A"');
    expect(
      getExportFormat('csv')!.buildPreviewText!(sample, ['sku', 'price'], {
        delimiter: ';',
        header: true,
      }),
    ).toBe('sku;price\nA;1');
    expect(
      getExportFormat('xml')!.buildPreviewText!(sample, null, {
        rootName: 'records',
        recordName: 'record',
      }),
    ).toContain('<record>');
    expect(getExportFormat('xlsx')!.previewKind).toBe('grid');
  });

  it('exportFilename follows the col / col-filtered convention', () => {
    const fmt = getExportFormat('csv');
    expect(exportFilename('vendors', 'all', fmt)).toBe('vendors.csv');
    expect(exportFilename('vendors', 'filtered', fmt)).toBe('vendors-filtered.csv');
  });

  it('buildExportJob assembles the runDownloadJob config', async () => {
    const stages = [{ $match: { region: 'EU' } }];
    const job = buildExportJob(
      {
        scope: 'filtered',
        formatId: 'csv',
        opts: { delimiter: ',', header: true, bom: false },
        columns: ['sku'],
        count: 42,
      },
      'vendors',
      stages,
    );
    expect(job.filename).toBe('vendors-filtered.csv');
    expect(job.filtered).toBe(true);
    expect(job.pipelineStages).toBe(stages);
    expect(await job.fetchCount()).toBe(42);
    expect(job.serializer.ext).toBe('csv');
  });

  it('fetchCount uses the finite config.count with NO api call (fast path)', async () => {
    const stages = [{ $match: { region: 'EU' } }];
    const job = buildExportJob(
      { scope: 'filtered', formatId: 'json', opts: {}, columns: null, count: 42 },
      'vendors',
      stages,
    );
    expect(await job.fetchCount()).toBe(42);
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('fetchCount runs a real $count over the job pipelineStages when config.count is null (CRITICAL fix)', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ total: 99 }] });
    const stages = [{ $match: { region: 'EU' } }];
    const job = buildExportJob(
      { scope: 'filtered', formatId: 'json', opts: {}, columns: null, count: null },
      'vendors',
      stages,
    );
    expect(await job.fetchCount()).toBe(99);
    expect(api.aggregate).toHaveBeenCalledTimes(1);
    expect(api.aggregate).toHaveBeenCalledWith('vendors', [...stages, { $count: 'total' }]);
  });

  it('fetchCount runs the real count for the "all" scope too, over [{$match:{}}]', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ total: 5 }] });
    const allJob = buildExportJob(
      { scope: 'all', formatId: 'json', opts: {}, columns: null, count: undefined },
      'vendors',
      null,
    );
    expect(allJob.pipelineStages).toEqual([{ $match: {} }]);
    expect(allJob.filtered).toBe(false);
    expect(await allJob.fetchCount()).toBe(5);
    expect(api.aggregate).toHaveBeenCalledWith('vendors', [{ $match: {} }, { $count: 'total' }]);
  });

  it('fetchCount resolves 0 when the real count aggregation returns no rows', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const job = buildExportJob(
      { scope: 'all', formatId: 'json', opts: {}, columns: null, count: NaN },
      'vendors',
      null,
    );
    expect(await job.fetchCount()).toBe(0);
  });

  it('fetchCount propagates an aggregate rejection instead of silently degrading to 0', async () => {
    vi.mocked(api.aggregate).mockRejectedValue(new Error('aggregate failed'));
    const job = buildExportJob(
      { scope: 'all', formatId: 'json', opts: {}, columns: null, count: null },
      'vendors',
      null,
    );
    await expect(job.fetchCount()).rejects.toThrow('aggregate failed');
  });
});
