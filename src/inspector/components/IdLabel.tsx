import { h } from 'preact';
import { useState } from 'preact/hooks';

// Show a human name; keep the machine id in a hover tooltip and copy it on click.
// Falls back to the id when no name resolved (never shows a wrong name).
export default function IdLabel(
  { name, id, prefix = '' }: { name?: string | null; id: unknown; prefix?: string },
) {
  const [copied, setCopied] = useState(false);
  if (name == null && id == null) return <span>{'—'}</span>;
  const label = name || `${prefix}${id}`;
  const copy = () => {
    if (id == null) return;
    try {
      navigator.clipboard.writeText(String(id));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  };
  return (
    <span
      class={`inspector-idlabel${name ? ' has-name' : ''}`}
      title={id != null ? `id ${id} — click to copy` : undefined}
      onClick={copy}
    >
      {label}{copied ? <span class="inspector-idlabel-copied">copied</span> : null}
    </span>
  );
}
