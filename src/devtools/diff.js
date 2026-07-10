// src/devtools/diff.js
// PURE: compute what changed between the fetched object and the edited object.
// Comparison is key-order-insensitive so reordering keys is not a "change".

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function deepEqual(a, b) { return stableStringify(a) === stableStringify(b); }

export function buildPatchBody(original, edited) {
  const o = original || {}, e = edited || {};
  const body = {};
  const removed = [];
  for (const k of Object.keys(e)) {
    if (!(k in o) || !deepEqual(o[k], e[k])) body[k] = e[k];
  }
  for (const k of Object.keys(o)) {
    if (!(k in e)) removed.push(k);
  }
  return { body, removed };
}

export function diffObjects(original, edited) {
  const o = original || {}, e = edited || {};
  const changed = [], added = [], removed = [];
  for (const k of Object.keys(e)) {
    if (!(k in o)) added.push(k);
    else if (!deepEqual(o[k], e[k])) changed.push(k);
  }
  for (const k of Object.keys(o)) if (!(k in e)) removed.push(k);

  const leaves = [];
  const isObj = (x) => x !== null && typeof x === 'object';
  const walk = (path, before, after) => {
    if (isObj(before) && isObj(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const k of keys) {
        const child = Array.isArray(before) || Array.isArray(after) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
        walk(child, before[k], after[k]);
      }
    } else if (!deepEqual(before, after)) {
      const kind = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
      leaves.push({ path, before, after, kind });
    }
  };
  for (const k of [...changed, ...added, ...removed]) walk(k, o[k], e[k]);
  return { changed, added, removed, leaves };
}
