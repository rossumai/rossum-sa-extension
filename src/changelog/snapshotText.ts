// Pretty JSON with keys sorted at every depth, so two snapshots diff by content and never
// by key order.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as any)[k]);
    return out;
  }
  return v;
}

export function snapshotText(snapshot: unknown): string {
  return JSON.stringify(sortKeys(snapshot), null, 2);
}
