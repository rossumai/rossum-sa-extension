import { getEjsonType, formatEjsonValue } from './displayValue.js';
import { flattenDoc } from './flatten.js';

// Pure, dependency-free CSV → JSON conversion for the Dataset Management app.
//
// There is no server-side CSV endpoint on the Data Storage API (confirmed),
// so the CSV is parsed in the browser and the resulting documents flow into
// the same chunked insert_many path the JSON importer uses. The tokenizer is
// dialect-configurable (delimiter / quote / escape / double-quote) so the
// importer can expose those exact options to the user.

// Tokenize CSV text into rows of string cells.
//
// dialect:
//   delimiter      (default ',')   field separator, outside quotes only
//   quoteChar      (default '"')    wraps fields containing delimiter/newlines
//   escapeChar     (default null)   inside quotes, emits the NEXT char literally
//   doubleQuote    (default true)   inside quotes, '""' -> one literal quote
//   skipEmptyLines (default true)   drop records that are a single empty, unquoted field
//
// Note: delimiter, quoteChar, and escapeChar must each be a single character;
// the tokenizer compares char-by-char and a multi-char value simply never matches.
// The caller/UI validates this — the tokenizer does not throw.
//
// Returns { rows: string[][], error: { message, line } | null }.
// Line terminators \r\n, \n, and lone \r are all auto-detected.
export type CsvDialect = {
  delimiter?: string; quoteChar?: string; escapeChar?: string;
  doubleQuote?: boolean; skipEmptyLines?: boolean;
};

export function tokenizeCsv(text: string, dialect: CsvDialect = {}) {
  const {
    delimiter = ',',
    quoteChar = '"',
    escapeChar = null,
    doubleQuote = true,
    skipEmptyLines = true,
  } = dialect;

  const rows: any[][] = [];
  let field = '';
  let row: any[] = [];
  let inQuotes = false;
  let sawQuote = false;     // any quote opened in the current row
  let quoteOpenLine = 1;    // line where the currently-open quote started
  let line = 1;             // 1-based line counter
  let error = null;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    const isBlank = row.length === 1 && row[0] === '' && !sawQuote;
    if (!(skipEmptyLines && isBlank)) rows.push(row);
    row = [];
    sawQuote = false;
  };

  const n = text.length;
  let p = 0;
  while (p < n) {
    const c = text[p];

    if (inQuotes) {
      if (escapeChar && c === escapeChar) {
        if (p + 1 < n) { field += text[p + 1]; p += 2; } else { field += c; p += 1; }
        continue;
      }
      if (c === quoteChar) {
        if (doubleQuote && text[p + 1] === quoteChar) { field += quoteChar; p += 2; continue; }
        inQuotes = false; p += 1; continue;
      }
      if (c === '\r') {
        field += c;
        if (text[p + 1] === '\n') { field += '\n'; p += 2; } else { p += 1; }
        line++;
        continue;
      }
      if (c === '\n') { field += c; line++; p += 1; continue; }
      field += c; p += 1; continue;
    }

    // outside quotes
    if (c === quoteChar && field === '') { inQuotes = true; sawQuote = true; quoteOpenLine = line; p += 1; continue; }
    if (c === delimiter) { endField(); p += 1; continue; }
    if (c === '\r') { endRow(); p += (text[p + 1] === '\n' ? 2 : 1); line++; continue; }
    if (c === '\n') { endRow(); p += 1; line++; continue; }
    field += c; p += 1;
  }

  if (inQuotes) error = { message: 'Unterminated quoted field', line: quoteOpenLine };

  // Flush a trailing record that had no closing terminator.
  if (field !== '' || row.length > 0 || inQuotes || sawQuote) endRow();

  return { rows, error };
}

// Conservative scalar inference for a single cell. Returns the original string
// unless it cleanly looks like an integer, decimal, or boolean. Leading-zero
// strings, scientific notation, signs, and anything with stray characters stay
// strings — so IDs / ZIPs / phone numbers are never silently corrupted.
export function inferValue(s: string): any {
  if (typeof s !== 'string') return s;
  const low = s.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (/^-?\d+$/.test(s)) {
    if (/^-?0\d/.test(s)) return s;          // leading zero -> keep as string
    if (s === '-0') return s;                // JSON has no negative zero
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;  // too big -> avoid precision loss
  }
  if (/^-?(\d+\.\d*|\.\d+)$/.test(s)) {
    if (/^-?0\d/.test(s)) return s;          // e.g. 01.5 -> keep as string
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

// Resolve a list of header names into unique, non-empty keys.
// Blank/whitespace names become column_<1-based-index>; later duplicates get a
// _2, _3, ... suffix. Value-trimming is the caller's job (see rowsToDocs).
// Note: suffixes are appended against the raw name, so e.g.
// ['a','a','a_2'] -> ['a','a_2','a_2_2'] (still unique, just not a clean sequence).
export function dedupeHeaders(names: string[]): string[] {
  const used = new Set();
  return names.map((raw, i) => {
    let name = raw == null ? '' : String(raw);
    if (name.trim() === '') name = `column_${i + 1}`;
    let candidate = name;
    let k = 2;
    while (used.has(candidate)) candidate = `${name}_${k++}`;
    used.add(candidate);
    return candidate;
  });
}

// Convert tokenized rows into document objects.
//
// opts:
//   hasHeader   (default true)     row 0 supplies field names
//   inferTypes  (default false)    apply inferValue to each non-empty cell
//   emptyMode   (default 'empty')  '' -> 'empty' (""), 'null' (null), or 'omit' (no key)
//   trim        (default false)    strip surrounding whitespace from each value
//
// Header names are always trimmed (object keys with stray whitespace are a
// footgun); the `trim` option governs data cells only.
// Returns { docs, columns, warnings }.
export function rowsToDocs(rows: any[][], opts: Record<string, any> = {}) {
  const { hasHeader = true, inferTypes = false, emptyMode = 'empty', trim = false } = opts;
  const warnings: any[] = [];
  if (!rows || rows.length === 0) return { docs: [], columns: [], warnings };

  const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);

  let columns;
  let dataRows;
  if (hasHeader) {
    const header = rows[0].map((c) => String(c == null ? '' : c).trim());
    while (header.length < maxLen) header.push('');     // name extra data columns
    columns = dedupeHeaders(header);
    if (rows[0].length < maxLen) {
      warnings.push(`${maxLen - rows[0].length} column(s) beyond the header were auto-named column_N.`);
    }
    dataRows = rows.slice(1);
  } else {
    columns = [];
    for (let i = 0; i < maxLen; i++) columns.push(`column_${i + 1}`);
    dataRows = rows;
  }

  let ragged = 0;
  const docs = dataRows.map((row) => {
    if (row.length !== columns.length) ragged++;
    const doc: Record<string, any> = {};
    for (let i = 0; i < columns.length; i++) {
      const raw = i < row.length ? row[i] : '';
      const v = trim ? raw.trim() : raw;
      if (v === '') {
        if (emptyMode === 'omit') continue;
        doc[columns[i] as string] = emptyMode === 'null' ? null : '';
        continue;
      }
      doc[columns[i] as string] = inferTypes ? inferValue(v) : v;
    }
    return doc;
  });

  if (ragged > 0) {
    warnings.push(`${ragged} row(s) have a different column count than the header.`);
  }
  return { docs, columns, warnings };
}

// Decode raw bytes (ArrayBuffer or TypedArray) to text. Unknown encoding
// labels fall back to utf-8 rather than throwing, so the UI can offer encodings
// without risk of a hard failure.
export function decodeBytes(buffer: ArrayBuffer | Uint8Array, encoding = 'utf-8'): string {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// Full pipeline used by the wizard: decode -> tokenize -> convert.
// `buffer` may be an ArrayBuffer/TypedArray (decoded with options.encoding) or
// a string (used as-is — handy for tests). On a tokenizer error, returns
// whatever rows were recovered (for preview) plus the error so the caller can
// block the import.
// `string` is in the union because the first line branches on it: callers hand this both
// decoded text and raw bytes.
export function parseCsv(buffer: ArrayBuffer | Uint8Array | string, options: Record<string, any> = {}) {
  const text = typeof buffer === 'string' ? buffer : decodeBytes(buffer, options.encoding);
  const { rows, error } = tokenizeCsv(text, options);
  const { docs, columns, warnings } = rowsToDocs(rows, options);
  return { docs, columns, warnings, error: error ?? null };
}

// Guess the delimiter for preselection: count raw occurrences of each candidate
// across the first few non-empty lines; the most frequent (>0) wins, else comma.
// Comma is preferred on a tie (it is the first candidate). Detection only seeds
// the UI — the user can override, and the parse honors the chosen delimiter.
export function detectDelimiter(text: string): string {
  const CANDIDATES = [',', ';', '\t'];
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 5);
  let best = ',';
  let bestCount = 0;
  for (const cand of CANDIDATES) {
    let count = 0;
    for (const line of lines) count += line.split(cand).length - 1;
    if (count > bestCount) { bestCount = count; best = cand; }
  }
  return best;
}

// ---- CSV export (serialization) — symmetric with the parser above ----

// Order discovered leaf paths for a CSV header: _id first (if present),
// then the rest alphabetically (locale-aware).
export function orderColumns(keys: string[]): string[] {
  const rest = keys.filter((k) => k !== '_id').sort((a, b) => a.localeCompare(b));
  return keys.includes('_id') ? ['_id', ...rest] : rest;
}

// Render one value as a CSV field (no delimiter). Objects/arrays are JSON-encoded.
// null/undefined -> empty; boolean -> true/false; number -> as-is; string -> as-is.
// Quote (and double internal quotes) when the field contains the delimiter,
// the quote char, CR, or LF.
export function csvCell(value: unknown, { delimiter = ',', quoteChar = '"' }: CsvDialect = {}): string {
  let s;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else if (typeof value === 'number') s = String(value);
  else if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    s = ejson ? formatEjsonValue(value, ejson) : JSON.stringify(value);
  }
  else s = String(value);
  if (s === '') return s;
  if (s.includes(delimiter) || s.includes(quoteChar) || s.includes('\n') || s.includes('\r')) {
    return quoteChar + s.split(quoteChar).join(quoteChar + quoteChar) + quoteChar;
  }
  return s;
}

// Join one document's column values into a CSV row. Columns are leaf PATHS
// (see columnDiscovery.ts), so the document is flattened by the same rule that
// produced the header — a missing path is an empty cell.
export function csvRow(doc: any, columns: string[], dialect: CsvDialect = {}): string {
  const delimiter = dialect.delimiter || ',';
  const flat = doc == null ? {} : flattenDoc(doc);
  return columns.map((c) => csvCell(flat[c], dialect)).join(delimiter);
}

// Header row from column names (names quoted by the same rule as cells).
export function csvHeader(columns: string[], dialect: CsvDialect = {}): string {
  const delimiter = dialect.delimiter || ',';
  return columns.map((c) => csvCell(c, dialect)).join(delimiter);
}
