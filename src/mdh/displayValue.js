// src/mdh/displayValue.js
// Shared single-value renderer. Used by JsonTree (expanded view) and
// recordSummary (collapsed preview). Kept as a plain .js module so it can
// be imported by tests without a JSX loader.

export const EJSON_TYPES = {
  $oid: { label: 'ObjectId', css: 'json-tree-value-oid' },
  $date: { label: 'Date', css: 'json-tree-value-date' },
  $numberLong: { label: 'Long', css: 'json-tree-value-number' },
  $numberInt: { label: 'Int', css: 'json-tree-value-number' },
  $numberDouble: { label: 'Double', css: 'json-tree-value-number' },
  $numberDecimal: { label: 'Decimal', css: 'json-tree-value-number' },
  $binary: { label: 'Binary', css: 'json-tree-value-null' },
  $regex: { label: 'Regex', css: 'json-tree-value-string' },
  $timestamp: { label: 'Timestamp', css: 'json-tree-value-date' },
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
