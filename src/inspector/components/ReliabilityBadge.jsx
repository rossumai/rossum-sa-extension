import { h } from 'preact';

const LABEL = {
  unavailable: 'Not recorded',
  high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence',
};

export default function ReliabilityBadge({ level }) {
  // 'unavailable' + the AI confidence levels are surfaced; 'verified'/'best-effort'
  // stay hidden (per the original product decision).
  if (!LABEL[level]) return null;
  return <span class={`inspector-rb inspector-rb-${level}`}>{LABEL[level]}</span>;
}
