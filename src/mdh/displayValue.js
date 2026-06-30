// src/mdh/displayValue.js
// Shared single-value renderer. Used by JsonTree (expanded view) and
// recordSummary (collapsed preview). Kept as a plain .js module so it can
// be imported by tests without a JSX loader.

// `label` = full type name (JsonTree badge, tooltips). `short` = compact
// lowercase tag for the dense Table view (RecordTable). Numeric subtypes share
// the `num` tag — the value + color already read as a number; the precise BSON
// subtype stays available via `label` (shown as the tag's tooltip).
export const EJSON_TYPES = {
  $oid: { label: 'ObjectId', short: 'oid', css: 'json-tree-value-oid' },
  $date: { label: 'Date', short: 'date', css: 'json-tree-value-date' },
  $numberLong: { label: 'Long', short: 'num', css: 'json-tree-value-number' },
  $numberInt: { label: 'Int', short: 'num', css: 'json-tree-value-number' },
  $numberDouble: { label: 'Double', short: 'num', css: 'json-tree-value-number' },
  $numberDecimal: { label: 'Decimal', short: 'num', css: 'json-tree-value-number' },
  $binary: { label: 'Binary', short: 'bin', css: 'json-tree-value-null' },
  $regex: { label: 'Regex', short: 're', css: 'json-tree-value-string' },
  $timestamp: { label: 'Timestamp', short: 'ts', css: 'json-tree-value-date' },
};

export function getEjsonType(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] in EJSON_TYPES) return keys[0];
  if (keys.length === 2 && keys.includes('$date')) return '$date';
  return null;
}

export function formatEjsonValue(value, typeKey) {
  const inner = value[typeKey];
  if (typeKey === '$oid') return String(inner);
  if (typeKey === '$date') {
    const d = typeof inner === 'string' ? inner : inner?.$numberLong || String(inner);
    try { return new Date(typeof d === 'string' && /^\d+$/.test(d) ? Number(d) : d).toISOString(); }
    catch { return String(d); }
  }
  if (typeKey === '$regex') return `/${inner}/${value.$options || ''}`;
  return String(inner);
}

export function displayValue(v) {
  if (v === null) return 'null';
  const ejson = getEjsonType(v);
  if (ejson) {
    const formatted = formatEjsonValue(v, ejson);
    return formatted.length > 24 ? formatted.slice(0, 24) + '...' : formatted;
  }
  if (typeof v === 'string') return v.length > 20 ? `"${v.slice(0, 20)}..."` : `"${v}"`;
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{...}';
  return String(v);
}

// Text that goes to the clipboard when the user copies a value from the JSON tree.
// Strings are returned unquoted (so they can be pasted straight into other systems).
// EJSON-typed values are returned in their inner human form (ObjectId hex, ISO date,
// numeric strings) so they can be reused in queries without the wrapper. Objects and
// arrays are pretty-printed JSON.
export function copyTextFor(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const ejson = getEjsonType(v);
  if (ejson) return formatEjsonValue(v, ejson);
  return JSON.stringify(v, null, 2);
}
