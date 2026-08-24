// Pure presentation logic over a validateAgainstShape() result (shape.ts) —
// turns the raw finding lists into the rows the shape-mismatch table
// (ImportConfirm.tsx) renders, plus the "N fields arrived flat" coalescing.
// DOM-free and fully unit-tested; no import of anything Preact-shaped.

import { splitPath } from './flatten.js';

export type LedgerRow = {
  path: string;
  root: string;
  collection: string | null;
  file: string | null;
  kind: 'missing' | 'unexpected' | 'type' | 'whitespace';
};

export type FlatCause = { root: string; leaves: string[] };

// The first (decoded) path segment — an escaped literal "a\.b" decodes to the
// single segment "a.b" and is its own root, never a child of a real "a".
function rootOf(path: string): string {
  return splitPath(path)[0];
}

// Stable-groups rows by root, in first-seen order, so leaves of the same
// parent sit together (e.g. every "key.*" row before the "address" root
// starts) without disturbing each root's own internal (finding-kind) order.
function groupByRoot(rows: LedgerRow[]): LedgerRow[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    if (!groups.has(row.root)) groups.set(row.root, []);
    (groups.get(row.root) as LedgerRow[]).push(row);
  }
  const out: LedgerRow[] = [];
  for (const rows_ of groups.values()) out.push(...rows_);
  return out;
}

// `check` is a validateAgainstShape() result (or any object shaped like one —
// callers, including tests, may pass a partial object).
export function buildLedger(check: any): LedgerRow[] {
  const missingTypes: Map<string, string> = check?.missingTypes || new Map();
  const unknownTypes: Map<string, string> = check?.unknownTypes || new Map();
  const rows: LedgerRow[] = [];

  for (const p of check?.missing || []) {
    rows.push({
      path: p,
      root: rootOf(p),
      collection: missingTypes.get(p) ?? null,
      file: null,
      kind: 'missing',
    });
  }
  for (const p of check?.unknown || []) {
    rows.push({
      path: p,
      root: rootOf(p),
      collection: null,
      file: unknownTypes.get(p) ?? null,
      kind: 'unexpected',
    });
  }
  for (const t of check?.typeMismatch || []) {
    rows.push({
      path: t.path,
      root: rootOf(t.path),
      collection: (t.expected || []).join('/'),
      file: t.got,
      kind: 'type',
    });
  }
  // Whitespace is deliberately different: the two cells hold SPELLINGS (the
  // collection's and the file's), not types — the two names are what differ.
  for (const w of check?.whitespace || []) {
    rows.push({
      path: w.got,
      root: rootOf(w.got),
      collection: w.expected,
      file: w.got,
      kind: 'whitespace',
    });
  }

  return groupByRoot(rows);
}

// Coalesces the classic "N missing + M unexpected" wall into the real count
// of distinct causes: a missing root whose bare name ALSO shows up as one
// whole unknown path is one field that arrived flat instead of nested, not
// two unrelated findings. Matching is done on DECODED values on both sides —
// an unknown entry can itself be a single escaped segment (a literal "a.b"
// field arriving flat), which does not equal a bare root by raw string
// comparison.
export function findFlattenedCauses(check: any): FlatCause[] {
  const missing: string[] = check?.missing || [];
  const unknown: string[] = check?.unknown || [];

  const flatRoots = new Set<string>();
  for (const u of unknown) {
    const segs = splitPath(u);
    if (segs.length === 1) flatRoots.add(segs[0]);
  }

  const byRoot = new Map<string, string[]>();
  for (const p of missing) {
    const root = rootOf(p);
    if (!byRoot.has(root)) byRoot.set(root, []);
    (byRoot.get(root) as string[]).push(p);
  }

  const out: FlatCause[] = [];
  for (const [root, leaves] of byRoot) {
    if (flatRoots.has(root)) out.push({ root, leaves });
  }
  return out;
}
