import { h } from 'preact';
import { parseNarrative } from './narrative.js';

// Renders one Fabry narrative body: takeaway paragraph, "- " bullet list, and a
// trailing "Next step:" line, streaming-safe. resolveCite is optional — when
// omitted, [e:<id>] segments render as plain text (Audit has no evidence model
// to cite into). resolveCite(id) → { title?, onClick? } | null.
function Segment({ seg, resolveCite }) {
  if (seg.type !== 'cite') return <span>{seg.text}</span>;
  if (!resolveCite) return <span>{seg.id}</span>;
  const hit = resolveCite(seg.id);
  if (!hit) return <span class="inspector-cite unresolved" title="cited evidence not found">{seg.id}</span>;
  return <button type="button" class="inspector-cite" title={hit.title || seg.id} onClick={hit.onClick}>{seg.id}</button>;
}

export default function FabryNarrative({ text, streaming, resolveCite }) {
  const blocks = parseNarrative(text);
  const out = [];
  let bullets = [];
  const seg = (segments) => segments.map((s) => <Segment seg={s} resolveCite={resolveCite} />);
  const flush = () => { if (bullets.length) { out.push(<ul class="inspector-diag-list">{bullets}</ul>); bullets = []; } };
  for (const b of blocks) {
    if (b.type === 'li') bullets.push(<li>{seg(b.segments)}</li>);
    else { flush(); out.push(<p>{seg(b.segments)}</p>); }
  }
  flush();
  return (
    <div class="inspector-diag-body">
      {out}
      {streaming ? <span class="inspector-caret" /> : null}
    </div>
  );
}
