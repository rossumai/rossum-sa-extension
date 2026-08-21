import { h } from 'preact';

// Inline "culprit" tag — the foregrounded attribution shown next to each item.
export default function CulpritChip({ culprit }: { culprit: any }) {
  if (!culprit) {
    return <span class="inspector-culp inspector-culp-none"><span class="cl">culprit</span> unattributed</span>;
  }
  return (
    <span class={`inspector-culp inspector-culp-${culprit.kind}`}>
      <span class="cl">culprit</span> {culprit.name}{culprit.id != null ? ` #${culprit.id}` : ''}
    </span>
  );
}
