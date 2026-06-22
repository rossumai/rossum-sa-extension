import { h } from 'preact';

const LABEL = { unavailable: 'Not recorded' };

export default function ReliabilityBadge({ level }) {
  // Only the 'unavailable' marker is surfaced; 'verified' and 'best-effort'
  // are intentionally not shown (per product decision).
  if (level !== 'unavailable') return null;
  return <span class={`inspector-rb inspector-rb-${level}`}>{LABEL[level] || level}</span>;
}
