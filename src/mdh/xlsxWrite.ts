// Hand-rolled, dependency-free .xlsx (OOXML) writer — symmetric to the reader
// in xlsx.js. ZIP framing + CRC-32 + minimal OOXML parts, native APIs only
// (CSP-clean). The big worksheet is deflated via CompressionStream('deflate-raw')
// and streamed with a ZIP data descriptor; the small metadata parts are stored.
import { getEjsonType, formatEjsonValue } from './displayValue.js';
import { dateToSerial } from './xlsxDates.js';
import * as api from './api.js';
import { orderColumns, buildColumnDiscoveryPipeline } from './csv.js';

const ENC = new TextEncoder();

// --- CRC-32 (polynomial 0xEDB88320) ---------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// Update a running CRC (input/output are the final, XORed value; seed 0 starts fresh).
export function crc32Update(running: number, bytes: Uint8Array): number {
  let c = (running ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
export function crc32(bytes: Uint8Array, seed = 0) {
  return crc32Update(seed, bytes);
}

// --- A1 column letters (inverse of xlsx.js#colToIndex) ---------------------
export function indexToCol(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// --- Excel worksheet-name rules: <=31 chars, no : \ / ? * [ ], non-empty ---
export function sanitizeSheetName(name: unknown): string {
  const cleaned = String(name == null ? '' : name).replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
  return cleaned.length ? cleaned : 'Sheet1';
}

// --- ZIP records -----------------------------------------------------------
function u16(dv: DataView, off: number, v: number) { dv.setUint16(off, v & 0xffff, true); }
function u32(dv: DataView, off: number, v: number) { dv.setUint32(off, v >>> 0, true); }

const DOS_TIME = 0;     // 00:00:00
const DOS_DATE = 0x21;  // 1980-01-01

// One ZIP entry's header fields. Named once: three record builders take overlapping subsets.
type ZipEntry = {
  name: string; method: number; flag: number;
  crc: number; compSize: number; uncompSize: number; offset: number;
};

export function localHeader({ name, method, flag, crc, compSize, uncompSize }: Omit<ZipEntry, 'offset'>) {
  const nameBytes = ENC.encode(name);
  const buf = new Uint8Array(30 + nameBytes.length);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x04034b50);
  u16(dv, 4, 20);
  u16(dv, 6, flag);
  u16(dv, 8, method);
  u16(dv, 10, DOS_TIME);
  u16(dv, 12, DOS_DATE);
  u32(dv, 14, crc);
  u32(dv, 18, compSize);
  u32(dv, 22, uncompSize);
  u16(dv, 26, nameBytes.length);
  u16(dv, 28, 0);
  buf.set(nameBytes, 30);
  return buf;
}

export function dataDescriptor({ crc, compSize, uncompSize }: Pick<ZipEntry, 'crc' | 'compSize' | 'uncompSize'>) {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x08074b50);
  u32(dv, 4, crc);
  u32(dv, 8, compSize);
  u32(dv, 12, uncompSize);
  return buf;
}

export function centralHeader({ name, method, flag, crc, compSize, uncompSize, offset }: ZipEntry) {
  const nameBytes = ENC.encode(name);
  const buf = new Uint8Array(46 + nameBytes.length);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x02014b50);
  u16(dv, 4, 20);
  u16(dv, 6, 20);
  u16(dv, 8, flag);
  u16(dv, 10, method);
  u16(dv, 12, DOS_TIME);
  u16(dv, 14, DOS_DATE);
  u32(dv, 16, crc);
  u32(dv, 20, compSize);
  u32(dv, 24, uncompSize);
  u16(dv, 28, nameBytes.length);
  u16(dv, 30, 0);
  u16(dv, 32, 0);
  u16(dv, 34, 0);
  u16(dv, 36, 0);
  u32(dv, 38, 0);
  u32(dv, 42, offset);
  buf.set(nameBytes, 46);
  return buf;
}

export function eocd({ count, cdSize, cdOffset }: { count: number; cdSize: number; cdOffset: number }) {
  const buf = new Uint8Array(22);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x06054b50);
  u16(dv, 4, 0);
  u16(dv, 6, 0);
  u16(dv, 8, count);
  u16(dv, 10, count);
  u32(dv, 12, cdSize);
  u32(dv, 16, cdOffset);
  u16(dv, 20, 0);
  return buf;
}

// --- cells & OOXML parts ---------------------------------------------------
export const DATE_STYLE_IDX = 1;

// Escape XML text content and drop chars illegal in XML 1.0 (keep \t \n \r).
// A char-code loop (not a literal control-char regex class) keeps this source
// pure-ASCII / CSP- and tooling-friendly.
export function escapeXmlText(s: unknown): string {
  const str = String(s);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    const ch = str[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else out += ch;
  }
  return out;
}

function inlineStr(ref: string, s: string) {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(s)}</t></is></c>`;
}

// One cell. Mapping is symmetric with csv.js#csvCell: EJSON $date -> date cell,
// everything else non-scalar -> its human string. null/undefined -> '' (omitted).
export function cellXml(value: unknown, ref: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return inlineStr(ref, String(value));
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    if (ejson === '$date') {
      const iso = formatEjsonValue(value, ejson);
      const serial = dateToSerial(new Date(iso));
      return `<c r="${ref}" s="${DATE_STYLE_IDX}"><v>${serial}</v></c>`;
    }
    const s = ejson ? formatEjsonValue(value, ejson) : JSON.stringify(value);
    return inlineStr(ref, s);
  }
  return inlineStr(ref, String(value));
}

export function rowXml(rowIndex0: number, values: unknown[]) {
  const r = rowIndex0 + 1;
  let cells = '';
  for (let c = 0; c < values.length; c++) cells += cellXml(values[c], `${indexToCol(c)}${r}`);
  return `<row r="${r}">${cells}</row>`;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const CONTENT_TYPES_XML = XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

export const ROOT_RELS_XML = XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

export const WB_RELS_XML = XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

export const STYLES_XML = XML_DECL +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm:ss"/></numFmts>' +
  '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs></styleSheet>';

export function workbookXml(sheetName: unknown) {
  return XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escapeXmlText(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

export const SHEET_HEAD = XML_DECL +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
export const SHEET_TAIL = '</sheetData></worksheet>';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_PART = 'xl/worksheets/sheet1.xml';

// Build a stored (method 0) entry: bytes + central-directory record.
function storedEntry(name: string, text: string, offset: number) {
  const data = ENC.encode(text);
  const crc = crc32(data);
  const header = localHeader({ name, method: 0, flag: 0, crc, compSize: data.length, uncompSize: data.length });
  const central = centralHeader({ name, method: 0, flag: 0, crc, compSize: data.length, uncompSize: data.length, offset });
  return { bytes: [header, data], central };
}

// Streaming binary serializer for the downloadCollection engine. The big sheet
// is deflated and streamed via a ZIP data descriptor; the small parts are stored.
export function buildXlsxSerializer(
  { sheetName = 'Sheet1', header = true, columns = null }:
  { sheetName?: string; header?: boolean; columns?: string[] | null } = {},
) {
  let cols: string[] | null = columns;
  let offset = 0;
  const centrals: Uint8Array[] = [];
  let sheetEntryOffset = 0;
  let cs: any, writer: any, pumpDone: Promise<void> | undefined, sheetCrc = 0, sheetUncomp = 0, sheetComp = 0;
  let rowIndex = 0;
  let writeBytesRef: ((bytes: Uint8Array) => Promise<void>) | null = null;

  // Single byte sink so `offset` always tracks the true byte position. Discriminate
  // on `typeof string`, NOT `instanceof Uint8Array` — CompressionStream output can
  // be a cross-realm Uint8Array (jsdom/Node) where `instanceof` is false, which
  // would re-encode bytes as text and corrupt the offsets.
  async function emit(chunk: string | Uint8Array) {
    const u8 = typeof chunk === 'string' ? ENC.encode(chunk) : chunk;
    offset += u8.length;
    await writeBytesRef!(u8);
  }
  // Feed uncompressed worksheet text into the deflate stream.
  async function feed(text: string) {
    const bytes = ENC.encode(text);
    sheetUncomp += bytes.length;
    sheetCrc = crc32Update(sheetCrc, bytes);
    await writer.write(bytes);
  }

  return {
    binary: true,
    ext: 'xlsx',
    mimeType: XLSX_MIME,
    pickerTypes: [{ description: 'Excel workbook', accept: { [XLSX_MIME]: ['.xlsx'] } }],

    async start(
      writeBytes: (bytes: Uint8Array) => Promise<void>,
      { collectionName, pipelineStages }: { collectionName: string; pipelineStages: any[] },
    ) {
      writeBytesRef = writeBytes;
      if (cols == null) {
        const res = await api.aggregate(collectionName, buildColumnDiscoveryPipeline(pipelineStages));
        cols = orderColumns(res?.result?.[0]?.keys ?? []);
      }
      sheetEntryOffset = offset;
      await emit(localHeader({ name: SHEET_PART, method: 8, flag: 0x0008, crc: 0, compSize: 0, uncompSize: 0 }));
      cs = new CompressionStream('deflate-raw');
      writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      pumpDone = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sheetComp += value.length;
          await emit(value);
        }
      })();
      await feed(SHEET_HEAD);
      if (header) { await feed(rowXml(rowIndex, cols!)); rowIndex++; }
    },

    async writeDocs(docs: any[]) {
      let buf = '';
      for (const doc of docs) {
        const values = cols!.map((c) => (doc == null ? undefined : doc[c]));
        buf += rowXml(rowIndex, values);
        rowIndex++;
      }
      if (buf) await feed(buf);
    },

    async finish() {
      await feed(SHEET_TAIL);
      await writer.close();
      await pumpDone;
      await emit(dataDescriptor({ crc: sheetCrc, compSize: sheetComp, uncompSize: sheetUncomp }));
      centrals.push(centralHeader({
        name: SHEET_PART, method: 8, flag: 0x0008,
        crc: sheetCrc, compSize: sheetComp, uncompSize: sheetUncomp, offset: sheetEntryOffset,
      }));
      const parts: [string, string][] = [
        ['[Content_Types].xml', CONTENT_TYPES_XML],
        ['_rels/.rels', ROOT_RELS_XML],
        ['xl/workbook.xml', workbookXml(sheetName)],
        ['xl/_rels/workbook.xml.rels', WB_RELS_XML],
        ['xl/styles.xml', STYLES_XML],
      ];
      for (const [name, text] of parts) {
        const e = storedEntry(name, text, offset);
        for (const b of e.bytes) await emit(b);
        centrals.push(e.central);
      }
      const cdOffset = offset;
      let cdSize = 0;
      for (const c of centrals) { cdSize += c.length; await emit(c); }
      await emit(eocd({ count: centrals.length, cdSize, cdOffset }));
    },
  };
}
