// src/training/baseline.js
// PURE. Turns an API response into a compact signature used for MISSION-START
// baselines and delta checks. Signatures may contain ONLY integers or
// "<int>:<int>" id pairs — never a name, a schema-field id or a collection
// name. A step must be verifiable without recording anything about the org's
// contents (see the spec, §5.2).

const idFromUrl = (url) => {
  const m = /\/(\d+)\/?$/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
};

const numsSorted = (list) => list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

export function hookQueuePairs(data) {
  const out = [];
  for (const hook of data?.results || []) {
    const hookId = idFromUrl(hook.url);
    if (hookId == null) continue;
    for (const q of hook.queues || []) {
      const queueId = idFromUrl(q);
      if (queueId != null) out.push(`${hookId}:${queueId}`);
    }
  }
  return out.sort();
}

// Counts every field-like node at ANY depth. VERIFIED LIVE on elis 2026-08-07:
// a line-item table nests as multivalue → `children` (a single OBJECT, not an
// array) → tuple → `children` (the array of column datapoints). Counting only
// `content[].children` would score a whole table as ONE field, so a trainee who
// added a table column would move the count by zero and the step would never
// tick, with no explanation. Sections are containers, not fields, so they are
// excluded; multivalue/tuple wrappers are counted, which is harmless because
// the check only cares that the number MOVED.
export function fieldCount(schema) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.id != null && node.category !== 'section') n += 1;
    if (node.children) walk(node.children); // array OR single object
  };
  walk(schema?.content);
  return n;
}

export function ruleIds(data) {
  return numsSorted((data?.results || []).map((r) => Number(r.id)));
}

export function thresholds(data) {
  const out = {};
  for (const q of data?.results || []) {
    const id = idFromUrl(q.url);
    if (id != null && typeof q.default_score_threshold === 'number') {
      out[id] = q.default_score_threshold;
    }
  }
  return out;
}

// The live contract for POST /collections/list is `{ result: [...] }` —
// SINGULAR. Verified against the shipping client: src/mdh/components/Sidebar.jsx
// reads `res.result`, and every test mock of that endpoint uses the same shape.
// `collections`/`results` are kept only as defensive fallbacks; reading the
// wrong key here returns 0 forever, which silently makes the step that depends
// on it impossible to complete.
export function collectionCount(data) {
  if (Array.isArray(data?.result)) return data.result.length;
  if (Array.isArray(data?.collections)) return data.collections.length;
  if (Array.isArray(data?.results)) return data.results.length;
  return 0;
}

// A NEW member (or a higher count) appeared. A missing baseline means the
// mission never started, so nothing can have grown.
export function grew(before, after) {
  if (before == null) return false;
  if (typeof before === 'number') return typeof after === 'number' && after > before;
  const seen = new Set(before);
  return (after || []).some((x) => !seen.has(x));
}

// A value the baseline already knew about now differs. New keys are not changes.
export function changed(before, after) {
  if (before == null) return false;
  return Object.keys(before).some((k) => after && k in after && after[k] !== before[k]);
}

const ID_PAIR = /^\d+:\d+$/;

export function isIdsOnly(sig) {
  if (sig == null) return true;
  if (typeof sig === 'number') return true;
  if (typeof sig === 'string') return ID_PAIR.test(sig);
  if (Array.isArray(sig)) return sig.every(isIdsOnly);
  if (typeof sig === 'object') {
    return Object.entries(sig).every(([k, v]) => /^\d+$/.test(k) && isIdsOnly(v));
  }
  return false;
}
