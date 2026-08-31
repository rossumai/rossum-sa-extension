// One home for MDH's "how long ago" grammar. Moved verbatim out of
// QueryHistory's private formatTime when the Search Indexes panel became a third
// caller — UploadsPanel keeps its own, which formats operation durations at a
// finer resolution ("1h 20m ago") and is a different grammar, not a duplicate.
export function formatTime(ts: any): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// MDH V2 returns `created_at` as UTC with NO offset marker
// ("2026-08-28T11:16:21.756000"), where the deprecated list returned the same
// instant as {"$date": "…Z"}. Date.parse reads an offset-less date-time as LOCAL
// time, so the bare string lands hours early and a card reads "just now" for the
// length of the UTC offset. Verified live 2026-08-28: the bare string matched the
// UTC wall clock to within the reconcile latency, not the local one.
export function parseUtcTimestamp(value: any): number | null {
  if (typeof value !== 'string' || !value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : ms;
}
