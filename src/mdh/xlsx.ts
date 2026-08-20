// Custom, dependency-free .xlsx (OOXML SpreadsheetML) reader.
// Uses ONLY native Web APIs — DecompressionStream('deflate-raw') for ZIP inflate
// and DOMParser for XML — so it is CSP-clean (no eval/new Function, no Worker) and
// adds no dependency. Values-only: strings/numbers/booleans decode natively; date
// cells arrive as their raw Excel serial number (no styles.xml). Produces the same
// shape as csv.js's parseCsv so the whole import tail is reused unchanged.

import { isDateFormat, serialToDate } from './xlsxDates.js';

// 'A1' -> 0, 'B' -> 1, 'AA10' -> 26. Reads the leading A–Z run only.
export function colToIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

// Pure: 2-D typed rows -> { docs, columns, warnings }. No type inference, no trim
// (cells are already natively typed); 0 and false are NOT treated as empty.
export function rowsToDocs(
  rows: any[][],
  { hasHeader = true, emptyMode = 'null', trim = false }:
    { hasHeader?: boolean; emptyMode?: string; trim?: boolean } = {},
) {
  const warnings: any[] = [];
  const dataRows = rows.filter((r) => !r.every(isEmpty));
  if (dataRows.length === 0) return { docs: [], columns: [], warnings };

  const width = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
  let header, body;
  if (hasHeader) {
    const h = dataRows[0];
    const seen = new Set();
    header = [];
    for (let i = 0; i < width; i++) {
      const name = isEmpty(h[i]) ? `column_${i + 1}` : String(h[i]);
      // Loop the suffix until unique against ALL already-emitted names, so a
      // header like ['id','id','id_2'] can't collide into two 'id_2' keys
      // (which would silently overwrite a value in the doc object).
      let candidate = name;
      let k = 2;
      while (seen.has(candidate)) candidate = `${name}_${k++}`;
      if (candidate !== name) {
        warnings.push(`Duplicate column name "${name}" renamed to "${candidate}".`);
      }
      seen.add(candidate);
      header.push(candidate);
    }
    body = dataRows.slice(1);
  } else {
    header = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
    body = dataRows;
  }

  const docs = body.map((r) => {
    const doc: Record<string, any> = {};
    for (let i = 0; i < header.length; i++) {
      let v = r[i];
      if (trim && typeof v === 'string') v = v.trim();
      if (isEmpty(v)) { if (emptyMode !== 'omit') doc[header[i] as string] = emptyMode === 'empty' ? '' : null; }
      else doc[header[i] as string] = v;
    }
    return doc;
  });
  const ragged = body.filter((r) => r.length > header.length).length;
  if (ragged) warnings.push(`${ragged} row(s) have more columns than the header; extra cells ignored.`);
  return { docs, columns: [...header], warnings };
}

function parseXml(str: string): Document {
  const doc = new DOMParser().parseFromString(str, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Malformed XML in .xlsx');
  return doc;
}
const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function readWorkbook(xmlString: string): { sheets: any[]; date1904: boolean } {
  const doc = parseXml(xmlString);
  const sheets = [...doc.getElementsByTagName('sheet')].map((el) => ({
    name: el.getAttribute('name') || '',
    rid: el.getAttribute('r:id') || el.getAttributeNS(RELS_NS, 'id') || '',
  }));
  const pr = doc.getElementsByTagName('workbookPr')[0];
  const d = pr ? (pr.getAttribute('date1904') || '') : '';
  const date1904 = d === '1' || d === 'true';
  return { sheets, date1904 };
}

// Parse styles.xml -> per-cellXfs-index boolean "is a date format". Each cell's
// `s` attribute indexes cellXfs; we resolve its numFmtId against the builtin
// date set + any custom <numFmt> codes.
export function readStyles(xmlString: string): boolean[] {
  const doc = parseXml(xmlString);
  const customFmt = new Map();
  for (const nf of doc.getElementsByTagName('numFmt')) {
    customFmt.set(Number(nf.getAttribute('numFmtId')), nf.getAttribute('formatCode') || '');
  }
  const cellXfs = doc.getElementsByTagName('cellXfs')[0];
  if (!cellXfs) return [];
  return [...cellXfs.getElementsByTagName('xf')].map((xf) => {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    return isDateFormat(id, customFmt.get(id));
  });
}

export function readRels(xmlString: string): Map<string, string> {
  const doc = parseXml(xmlString);
  const map = new Map();
  for (const el of doc.getElementsByTagName('Relationship')) map.set(el.getAttribute('Id'), el.getAttribute('Target'));
  return map;
}

export function readSharedStrings(xmlString: string): string[] {
  const doc = parseXml(xmlString);
  // One entry per <si>; concatenate every <t> beneath it (covers plain + rich-text runs).
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
}

export function readSheet(
  xmlString: string, sharedStrings: string[],
  { styleIsDate = [], date1904 = false }: { styleIsDate?: boolean[]; date1904?: boolean } = {},
): any[][] {
  const doc = parseXml(xmlString);
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const cells = [];
    let auto = 0;
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      const idx = ref ? colToIndex(ref) : auto;
      auto = idx + 1;
      const t = c.getAttribute('t');
      let value;
      if (t === 'inlineStr') {
        value = [...c.getElementsByTagName('t')].map((e) => e.textContent).join('');
      } else {
        const v = c.getElementsByTagName('v')[0];
        const raw = v ? v.textContent : null;
        if (raw == null) value = undefined;
        else if (t === 's') value = sharedStrings[Number(raw)];
        else if (t === 'b') value = raw === '1';
        else if (t === 'str') value = raw;
        else if (t === 'd') value = raw;          // ISO date string (rare) — kept as-is
        else if (t === 'e') value = null;         // error cell
        else {
          // number (incl. date serials) — convert to {$date} when the cell's
          // style is a date number-format.
          const num = Number(raw);
          const s = Number(c.getAttribute('s') || 0);
          value = styleIsDate[s] ? { $date: serialToDate(num, { date1904 }).toISOString() } : num;
        }
      }
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes as any).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal ZIP reader: parse the central directory, then for each entry inflate
// (method 8) or copy (method 0). Throws on a non-ZIP buffer, Zip64, or an
// unsupported compression method.
export async function unzip(arrayBuffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const dec = new TextDecoder();

  // Find End Of Central Directory (sig 0x06054b50), scanning back over the comment.
  let eocd = -1;
  const min = Math.max(0, dv.byteLength - 22 - 0xffff);
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record).');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported.');

  // Walk central-directory headers (sig 0x02014b50). Sizes here are authoritative
  // even when local headers use a trailing data descriptor.
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map();
  for (const e of entries) {
    if (dv.getUint32(e.localOffset, true) !== 0x04034b50) throw new Error(`Bad local header for ${e.name}`);
    const lNameLen = dv.getUint16(e.localOffset + 26, true);
    const lExtraLen = dv.getUint16(e.localOffset + 28, true);
    const start = e.localOffset + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) out.set(e.name, comp.slice());
    else if (e.method === 8) out.set(e.name, await inflateRaw(comp));
    else throw new Error(`Unsupported compression method ${e.method} for ${e.name}`);
  }
  return out;
}

const textOf = (u8: Uint8Array) => new TextDecoder().decode(u8);

export async function parseXlsx(
  arrayBuffer: ArrayBuffer,
  { sheet, hasHeader = true, emptyMode = 'null', trim = false }:
    { sheet?: string; hasHeader?: boolean; emptyMode?: string; trim?: boolean } = {},
) {
  try {
    const files = await unzip(arrayBuffer);
    const wbBytes = files.get('xl/workbook.xml');
    if (!wbBytes) throw new Error('Not a valid .xlsx workbook (missing xl/workbook.xml).');
    const { sheets: defs, date1904 } = readWorkbook(textOf(wbBytes));
    if (defs.length === 0) throw new Error('Workbook has no sheets.');
    const sheets = defs.map((s: any) => s.name);

    const relsBytes = files.get('xl/_rels/workbook.xml.rels');
    const rels = relsBytes ? readRels(textOf(relsBytes)) : new Map();

    const def = (sheet ? defs.find((s: any) => s.name === sheet) : defs[0]) || defs[0];
    const target = rels.get(def.rid);
    let path;
    if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    else path = `xl/worksheets/sheet${defs.indexOf(def) + 1}.xml`; // positional fallback
    const sheetBytes = files.get(path);
    if (!sheetBytes) throw new Error('Worksheet part not found.');

    const ssBytes = files.get('xl/sharedStrings.xml');
    const shared = ssBytes ? readSharedStrings(textOf(ssBytes)) : [];
    const stylesBytes = files.get('xl/styles.xml');
    const styleIsDate = stylesBytes ? readStyles(textOf(stylesBytes)) : [];

    const rows = readSheet(textOf(sheetBytes), shared, { styleIsDate, date1904 });
    const { docs, columns, warnings } = rowsToDocs(rows, { hasHeader, emptyMode, trim });
    return { docs, columns, warnings, error: null, sheets };
  } catch (err) {
    return { docs: [], columns: [], warnings: [], error: { message: (err as Error).message }, sheets: [] };
  }
}
