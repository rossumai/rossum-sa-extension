// Pure diff of persisted annotation.messages[] vs a live validate() result —
// "would today's config treat this annotation differently?" Messages have no
// stable identity, so key by (type, content, datapoint id).
const key = (m: any) => `${m?.type ?? ''}|${m?.content ?? ''}|${m?.id ?? ''}`;

export function driftDiff(persisted: any, live: any, matchedRules: any[] = []) {
  const p = Array.isArray(persisted) ? persisted : [];
  const l = Array.isArray(live) ? live : [];
  const pKeys = new Set(p.map(key));
  const lKeys = new Set(l.map(key));
  return {
    added: l.filter((m) => !pKeys.has(key(m))),
    removed: p.filter((m) => !lKeys.has(key(m))),
    unchanged: p.filter((m) => lKeys.has(key(m))),
    matchedRules: Array.isArray(matchedRules) ? matchedRules : [],
  };
}
