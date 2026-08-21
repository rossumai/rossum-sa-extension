import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';

// Inline code for short snippets; collapsible block for long/multi-line ones
// (some rule trigger_conditions are long, multi-line scripts).
export default function FoldableCode({ code }: { code?: string | null }) {
  const [open, setOpen] = useState(false);
  const s = String(code == null ? '' : code);
  const long = s.length > 90 || s.includes('\n');
  if (!long) return <code class="inspector-code">{s}</code>;
  const firstLine = s.split('\n')[0];
  return (
    <Fragment>
      {open
        ? <pre class="inspector-code-block">{s}</pre>
        : <code class="inspector-code">{firstLine.slice(0, 90)}{(firstLine.length > 90 || s.includes('\n')) ? '…' : ''}</code>}
      {' '}
      <button class="inspector-fold-btn" type="button" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>
    </Fragment>
  );
}
