import { h } from 'preact';

const LABEL: Record<string, string> = {
  unavailable: 'Not recorded',
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export default function ReliabilityBadge({ level }: { level?: string | null }) {
  // 'unavailable' + the AI confidence levels are surfaced; 'verified'/'best-effort'
  // stay hidden (per the original product decision).
  // An absent level indexes to undefined, which is falsy — the original guard already
  // covered it, so this stays a cast rather than becoming an extra runtime check.
  if (!LABEL[level as string]) return null;
  return <span class={`inspector-rb inspector-rb-${level}`}>{LABEL[level as string]}</span>;
}
