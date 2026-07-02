// A single-key object whose one key starts with '$' is an EJSON wrapper — a leaf.
function isEjsonWrapper(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const ks = Object.keys(v);
  return ks.length === 1 && ks[0].startsWith('$');
}

function walkPaths(obj, prefix, depth, maxDepth, out) {
  for (const k of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (depth < maxDepth && v !== null && typeof v === 'object' && !Array.isArray(v) && !isEjsonWrapper(v) && Object.keys(v).length > 0) {
      walkPaths(v, path, depth + 1, maxDepth, out);
    } else {
      out.add(path);
    }
  }
}

// Sorted union of dotted leaf paths across a sample of docs; _id first.
export function collectFieldPaths(docs, { sampleSize = 50, maxDepth = 5 } = {}) {
  const out = new Set();
  const n = Math.min(docs.length, sampleSize);
  for (let i = 0; i < n; i++) {
    const d = docs[i];
    if (d && typeof d === 'object' && !Array.isArray(d)) walkPaths(d, '', 1, maxDepth, out);
  }
  const arr = [...out].sort();
  const idx = arr.indexOf('_id');
  if (idx > 0) { arr.splice(idx, 1); arr.unshift('_id'); }
  return arr;
}
