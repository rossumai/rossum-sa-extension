import { isEjsonWrapper } from './flatten.js';

function walkPaths(
  obj: any,
  prefix: string,
  depth: number,
  maxDepth: number,
  out: Set<string>,
): void {
  for (const k of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (
      depth < maxDepth &&
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !isEjsonWrapper(v) &&
      Object.keys(v).length > 0
    ) {
      walkPaths(v, path, depth + 1, maxDepth, out);
    } else {
      out.add(path);
    }
  }
}

// Sorted union of dotted leaf paths across a sample of docs; _id first.
export function collectFieldPaths(
  docs: any[],
  { sampleSize = 50, maxDepth = 5 }: { sampleSize?: number; maxDepth?: number } = {},
): string[] {
  const out = new Set<string>();
  const n = Math.min(docs.length, sampleSize);
  for (let i = 0; i < n; i++) {
    const d = docs[i];
    if (d && typeof d === 'object' && !Array.isArray(d)) walkPaths(d, '', 1, maxDepth, out);
  }
  const arr = [...out].sort();
  const idx = arr.indexOf('_id');
  if (idx > 0) {
    arr.splice(idx, 1);
    arr.unshift('_id');
  }
  return arr;
}

// Presence of a dotted key path via own-property walk; arrays are leaves.
function hasPath(doc: any, path: string): boolean {
  let cur = doc;
  for (const seg of String(path).split('.')) {
    if (
      cur === null ||
      typeof cur !== 'object' ||
      Array.isArray(cur) ||
      !Object.prototype.hasOwnProperty.call(cur, seg)
    )
      return false;
    cur = cur[seg];
  }
  return true;
}

// How many rows would make the server-side Update fail outright: a row missing
// ANY match key fails the WHOLE data-matching PATCH (verified live 2026-07-03,
// CLIENT_ERROR "ID key ... not found in the updated element"). A null key
// value is accepted by the server, so null counts as present.
export function countRowsMissingKeys(docs: any[], keys: string[]): number {
  if (!Array.isArray(docs) || !Array.isArray(keys) || keys.length === 0) return 0;
  let n = 0;
  for (const d of docs) {
    const obj = d && typeof d === 'object' && !Array.isArray(d) ? d : null;
    if (!obj || !keys.every((k) => hasPath(obj, k))) n++;
  }
  return n;
}
