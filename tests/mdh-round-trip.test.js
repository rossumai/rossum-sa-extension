// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { csvHeader, csvRow, parseCsv, orderColumns } from '../src/mdh/csv.js';
import { docToXml, parseXml } from '../src/mdh/xml.js';
import { buildXlsxSerializer } from '../src/mdh/xlsxWrite.js';
import { parseXlsx } from '../src/mdh/xlsx.js';
import { discoverLeafPaths } from '../src/mdh/columnDiscovery.js';
import { restoreDocs } from '../src/mdh/restoreValues.js';
import { deriveShape, validateAgainstShape } from '../src/mdh/shape.js';
import { dedupeById } from '../src/mdh/importFile.js';
import { flattenDoc } from '../src/mdh/flatten.js';

// Synthetic. One value of every kind that the flat formats flatten, plus an
// optional field so a non-uniform collection is covered.
const RECORDS = [
  {
    _id: { $oid: '000000000000000000000001' },
    key: { code: 'AAA', system: 'SysOne' },
    name: 'ALPHA SUPPLIES LTD',
    terms: 'NET45',
    active: true,
    limit: 1500,
    tags: ['x', 'y'],
    address: { line: ['PO BOX 1'], city: 'TOWN', country: 'US' },
    ref: { $oid: '0000000000000000000000ff' },
  },
  {
    _id: { $oid: '000000000000000000000002' },
    key: { code: 'BBB', system: 'SysOne' },
    name: 'BETA WORKS INC',
    terms: 'NET30',
    active: false,
    limit: 250,
    tags: ['z'],
    address: { line: ['1 MAIN ST'], city: 'CITY', country: 'US', region: 'ST' },
    ref: { $oid: '0000000000000000000000fe' },
    updated: { $date: '2026-01-31T09:00:00.000Z' },
  },
];

const SHAPE = deriveShape(RECORDS);

// The union of leaf paths, computed the way the real export computes it: drive
// discoverLeafPaths with a fake aggregate that answers each level from RECORDS.
async function leafPaths() {
  const aggregate = async (_c, pipeline) => {
    const facet = pipeline[pipeline.length - 1].$facet;
    const out = {};
    for (const [fk, stages] of Object.entries(facet)) {
      const expr = stages[0].$project.kv.$cond[1].$objectToArray;
      const path = expr === '$$ROOT' ? null : expr.slice(1);
      const byKey = new Map();
      for (const rec of RECORDS) {
        const node = path === null ? rec : path.split('.').reduce((o, s) => (o == null ? o : o[s]), rec);
        if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
        for (const [k, v] of Object.entries(node)) {
          if (!byKey.has(k)) byKey.set(k, new Set());
          byKey.get(k).add(
            v === null ? 'null'
              : Array.isArray(v) ? 'array'
                : typeof v === 'object' ? (Object.keys(v).length === 1 && Object.keys(v)[0].startsWith('$') ? Object.keys(v)[0].slice(1) : 'object')
                  : typeof v === 'number' ? 'int' : typeof v === 'boolean' ? 'bool' : 'string',
          );
        }
      }
      out[fk] = [...byKey].map(([k, types]) => ({ _id: k, types: [...types] }));
    }
    return { result: [out] };
  };
  return orderColumns(await discoverLeafPaths('c', [{ $match: {} }], { aggregate }));
}

// The real Insert tail: restore, then dedupeById (which re-wraps a 24-hex _id
// as {$oid} via normalizeDocId).
const importTail = (docs) => dedupeById(restoreDocs(docs, SHAPE).docs).kept;

function expectRoundTrip(restored) {
  expect(validateAgainstShape(restored, SHAPE)).toMatchObject({ ok: true });
  expect(restored).toEqual(RECORDS);
}

describe('export → import round trip (the guarantee)', () => {
  it('JSON / JSONL is lossless', () => {
    expectRoundTrip(importTail(JSON.parse(JSON.stringify(RECORDS))));
  });

  it('CSV', async () => {
    const columns = await leafPaths();
    const text = [csvHeader(columns), ...RECORDS.map((d) => csvRow(d, columns))].join('\r\n');
    expectRoundTrip(importTail(parseCsv(text, {}).docs));
  });

  it('Excel', async () => {
    const columns = await leafPaths();
    const ser = buildXlsxSerializer({ sheetName: 'Sheet1', header: true, columns });
    const parts = [];
    await ser.start(async (b) => { parts.push(b.slice()); }, { collectionName: 'c', pipelineStages: [] });
    await ser.writeDocs(RECORDS);
    await ser.finish();
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { bytes.set(p, off); off += p.length; }
    expectRoundTrip(importTail((await parseXlsx(bytes.buffer, {})).docs));
  });

  it('XML', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<records>\n'
      + RECORDS.map((d) => '  ' + docToXml(d, 'record')).join('\n')
      + '\n</records>\n';
    expectRoundTrip(importTail(parseXml(xml, {}).docs));
  });
});

describe('backward compatibility (spec §5)', () => {
  it('a CSV exported BEFORE this change still imports correctly', () => {
    // Legacy layout: top-level headers only, each nested value one JSON cell.
    const columns = orderColumns([...new Set(RECORDS.flatMap((d) => Object.keys(d)))]);
    const legacyRow = (doc) => columns
      .map((c) => {
        const v = doc[c];
        if (v === undefined) return '';
        if (v && typeof v === 'object' && Object.keys(v).length === 1 && Object.keys(v)[0].startsWith('$')) {
          return Object.values(v)[0];
        }
        if (v && typeof v === 'object') return '"' + JSON.stringify(v).split('"').join('""') + '"';
        return String(v);
      })
      .join(',');
    const text = [csvHeader(columns), ...RECORDS.map(legacyRow)].join('\r\n');
    expectRoundTrip(importTail(parseCsv(text, {}).docs));
  });

  it('restore OFF leaves the parsed docs exactly as the parser produced them', () => {
    const parsed = parseCsv('a.b,c\r\n1,2', {}).docs;
    expect(parsed).toEqual([{ 'a.b': '1', c: '2' }]);   // no nesting without restore
  });
});

describe('a mixed object/scalar path round-trips through CSV (reviewer-measured defect)', () => {
  it('exports a header its own importer can re-read, with no false conflict', () => {
    const docs = [{ sku: 'A', v: { inner: 'X' } }, { sku: 'B', v: 'plain' }];
    const shape = deriveShape(docs);
    const columns = orderColumns([...new Set(docs.flatMap((d) => Object.keys(flattenDoc(d))))]);
    expect(columns).toEqual(['sku', 'v', 'v.inner']);

    const text = [csvHeader(columns), ...docs.map((d) => csvRow(d, columns))].join('\r\n');
    const { docs: parsed } = parseCsv(text, {});
    const { docs: restored, summary } = restoreDocs(parsed, shape);

    expect(summary.warnings).toEqual([]);
    expect(restored).toEqual(docs);
    expect(validateAgainstShape(restored, shape)).toMatchObject({ ok: true, unknown: [], failedDocCount: 0 });
  });
});

describe('the header the export writes matches the header the flattener produces', () => {
  it('every discovered path is a key of every flattened record, or absent from it', async () => {
    const columns = await leafPaths();
    for (const rec of RECORDS) {
      for (const k of Object.keys(flattenDoc(rec))) {
        expect(columns).toContain(k);   // nothing a record holds is missing from the header
      }
    }
  });
});
