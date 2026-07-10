// Pure, DOM-free narrative parsing for Fabry answers — line-aware paragraph/
// bullet blocks with inline [e:<id>] citation segments. Streaming-safe (a
// partial last line still renders). Canonical home for the shared Fabry UI —
// the single implementation used by both the Inspector and Audit apps.
const CITE_RE = /\[e:([A-Za-z0-9_.:-]+)\]/g;

export function parseCitations(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out = [];
  let last = 0;
  for (const m of s.matchAll(CITE_RE)) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'cite', id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

export function parseNarrative(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const blocks = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^[-•]\s+(.*)$/.exec(t);
    blocks.push(m ? { type: 'li', segments: parseCitations(m[1]) } : { type: 'p', segments: parseCitations(t) });
  }
  return blocks;
}
