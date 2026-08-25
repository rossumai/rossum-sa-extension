import json from './json.js';
import jsonl from './jsonl.js';
import csv from './csv.jsx';
import xlsx from './xlsx.jsx';
import xml from './xml.jsx';

export type Format = {
  id: string;
  label: string;
  accept: string;
  read: string;
  parse: (text: any, opts?: any) => any;
  defaultOpts?: any;
  /** Sniff options out of the input (csv delimiter, xml record key). */
  detectOpts?: (text: any) => any;
  /** The format's own Configure step, when it has options worth showing. */
  ConfigureControls?: any;
};

export const FORMATS: Record<string, Format> = { json, jsonl, csv, xlsx, xml };
export type FormatId = string;
export function getFormat(id: string): Format {
  return FORMATS[id];
}

// Union of every format's `accept` — used by the file drop area so ONE picker
// accepts any supported type.
export const ALL_ACCEPT = Object.values(FORMATS)
  .map((f) => f.accept)
  .join(',');

// Map a filename to a format id by its extension (case-insensitive). `.ndjson`
// and `.jsonl` both map to jsonl. Returns null for an unsupported extension.
const EXT_TO_FORMAT: Record<string, FormatId> = {
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  csv: 'csv',
  xlsx: 'xlsx',
  xml: 'xml',
};
export function detectFormat(filename: string | null | undefined): FormatId | null {
  const m = /\.([^.]+)$/.exec(String(filename || '').toLowerCase());
  if (!m) return null;
  return EXT_TO_FORMAT[m[1]] || null;
}
