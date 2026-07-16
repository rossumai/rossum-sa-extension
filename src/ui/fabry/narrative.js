// Pure, DOM-free narrative parsing for Fabry answers — line-aware paragraph/
// bullet blocks with inline [e:<id>] citation segments. Streaming-safe (a
// partial last line still renders). Canonical home for the shared Fabry UI —
// the single implementation used by both the Inspector and Audit apps.
const CITE_RE = /\[e:([A-Za-z0-9_.:-]+)\]/g;

export function parseCitations(text, streaming = false) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out = [];
  let last = 0;
  for (const m of s.matchAll(CITE_RE)) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'cite', id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    let tail = s.slice(last);
    // Streaming-safe: WHILE STREAMING only, drop a trailing not-yet-closed citation
    // marker ("…[e:blocker") so the raw marker doesn't flash before its "]" arrives.
    // On a FINISHED render we keep the text verbatim — never silently truncate a
    // completed narrative that legitimately ends with "[e:" prose or a malformed cite.
    if (streaming) tail = tail.replace(/\[e:[A-Za-z0-9_.:-]*$/, '');
    if (tail) out.push({ type: 'text', text: tail });
  }
  return out;
}

export function parseNarrative(text, streaming = false) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const blocks = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^[-•]\s+(.*)$/.exec(t);
    blocks.push(m ? { type: 'li', segments: parseCitations(m[1], streaming) } : { type: 'p', segments: parseCitations(t, streaming) });
  }
  return blocks;
}
