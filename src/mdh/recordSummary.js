// src/mdh/recordSummary.js
// Pure helpers for the collapsed record preview. No Preact, no signals,
// no DOM — everything is passed in by the caller. See
// docs/superpowers/specs/2026-04-15-record-preview-design.md.

import { displayValue, getEjsonType } from './displayValue.js';

// Width-packing constants. Exported so tests can override without mocking.
export const RESERVED_PX = 180;    // chevron (~20) + actions (~130) + padding (~30)
export const CHAR_WIDTH_PX = 6.6;  // empirical for 11px monospace (.record-summary)
export const MIN_CHAR_BUDGET = 30;
export const SUFFIX_RESERVE = 14;  // covers " · +99 fields" with one char of slack
export const EMPTY_SENTINEL = '(empty record)';

const NAME_PATTERN_EXACT = /^(name|title|code|label|key|description|summary)$/i;
const NAME_PATTERN_SUFFIX = /(_name|_code|_title)$/i;

function isPrimitive(v) {
  if (v === null) return false;
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function indexedTopLevelPaths(indexes) {
  // Collects the set of top-level path segments referenced by any non-default index.
  const paths = new Set();
  if (!Array.isArray(indexes)) return paths;
  for (const idx of indexes) {
    if (!idx || idx.name === '_id_') continue;
    const key = idx.key;
    if (!key || typeof key !== 'object') continue;
    for (const k of Object.keys(key)) {
      const dot = k.indexOf('.');
      paths.add(dot >= 0 ? k.slice(0, dot) : k);
    }
  }
  return paths;
}

function classifyTier(key, value, indexedPaths) {
  if (key === '_id') return 5;
  if (indexedPaths.has(key)) return 1;
  if (NAME_PATTERN_EXACT.test(key) || NAME_PATTERN_SUFFIX.test(key)) return 2;
  if ((isPrimitive(value) && value !== '') || getEjsonType(value) !== null) return 3;
  return 4; // nested object, array, null, empty string
}

export function rankFields(record, { indexes } = {}) {
  const keys = Object.keys(record);
  if (keys.length === 0) return [];
  const indexedPaths = indexedTopLevelPaths(indexes);
  const tiered = keys.map((k, i) => ({
    key: k,
    tier: classifyTier(k, record[k], indexedPaths),
    order: i,
  }));
  tiered.sort((a, b) => a.tier - b.tier || a.order - b.order);
  return tiered.map((x) => x.key);
}

const SEPARATOR = ' \u00b7 ';

function formatEntry(key, value) {
  return `${key}: ${displayValue(value)}`;
}

function pluralSuffix(n) {
  return ` \u00b7 +${n} field${n === 1 ? '' : 's'}`;
}

function oidString(value) {
  // Returns the raw hex for an EJSON $oid, or null if not an ObjectId.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$oid' && typeof value.$oid === 'string') return value.$oid;
  }
  return null;
}

function formatIdFallback(value) {
  const oid = oidString(value);
  if (oid && oid.length >= 13) {
    return `_id: ${oid.slice(0, 8)}\u2026${oid.slice(-4)}`;
  }
  return `_id: ${displayValue(value)}`;
}

function narrowFirstEntry(key, value, charBudget) {
  // Emit "key: <truncated>\u2026" fitting into charBudget.
  // Reserve keyName.length + ": " (2) + "\u2026" (1) = keyName + 3 chars of overhead.
  const overhead = key.length + 3;
  const rendered = displayValue(value);
  const room = Math.max(4, charBudget - overhead);
  if (rendered.length <= room) return `${key}: ${rendered}`;
  return `${key}: ${rendered.slice(0, room)}\u2026`;
}

export function recordSummary(record, charBudget, opts = {}) {
  const ranked = rankFields(record, opts);
  if (ranked.length === 0) return EMPTY_SENTINEL;

  // _id-only fallback: record has nothing but _id.
  if (ranked.length === 1 && ranked[0] === '_id') {
    return formatIdFallback(record._id);
  }

  const tailBudget = charBudget - SUFFIX_RESERVE;
  const parts = [];
  let used = 0;

  for (let i = 0; i < ranked.length; i++) {
    const key = ranked[i];
    const entry = formatEntry(key, record[key]);
    const withSep = parts.length === 0 ? entry.length : SEPARATOR.length + entry.length;
    if (parts.length > 0 && used + withSep > tailBudget) break;
    if (parts.length === 0 && entry.length > tailBudget) {
      // Narrow-budget fallback: emit field #1 with aggressive value truncation
      // and no +N fields tail. Chevron signals "more inside".
      return narrowFirstEntry(key, record[key], charBudget);
    }
    parts.push(entry);
    used += withSep;
  }

  const dropped = ranked.length - parts.length;
  const joined = parts.join(SEPARATOR);
  return dropped > 0 ? joined + pluralSuffix(dropped) : joined;
}
