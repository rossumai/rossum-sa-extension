import { h } from 'preact';
import { useState } from 'preact/hooks';
import StatsFieldCard from './StatsFieldCard.jsx';

const SORTS = [['issues', 'Issues first'], ['name', 'Name']];

function isFlagged(p: any) {
  return !!((p.sentinel && p.sentinel.total > 0) || p.isMixed
    || (p.string && (p.string.leading > 0 || p.string.trailing > 0))
    || (p.nullCount + p.missingCount + p.emptyCount) > 0);
}

function sortProfiles(profiles: any, sort: any) {
  const arr = [...profiles];
  if (sort === 'name') arr.sort((a, b) => a.field.localeCompare(b.field));
  else arr.sort((a, b) => ((isFlagged(b) as any) - (isFlagged(a) as any)) || (b.diversityPct - a.diversityPct)); // issues first
  return arr;
}

export default function StatsFieldGrid(
  { profiles, indexMap }: { profiles: any[]; indexMap?: Record<string, any> },
) {
  const [sort, setSort] = useState('issues');
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const sorted = sortProfiles(profiles, sort);
  const matches = (p: any) => p.field.toLowerCase().includes(f);
  // When filtering, float matching fields to the front but keep the rest
  // visible (dimmed), preserving each group's sort order.
  const ordered = f ? [...sorted.filter(matches), ...sorted.filter((p) => !matches(p))] : sorted;
  return (
    <div>
      <div class="stats-fgrid-head">
        <span class="stats-band-label">Fields {'·'} {profiles.length}</span>
        <input class="stats-fgrid-filter" placeholder={'filter fields…'} value={filter} onInput={(e: any) => setFilter(e.target.value)} />
        <span class="view-seg">
          {SORTS.map(([k, label]) => (
            <button type="button" class={`view-seg-opt${sort === k ? ' on' : ''}`} onClick={() => setSort(k)}>{label}</button>
          ))}
        </span>
      </div>
      <div class="stats-grid">
        {ordered.map((p) => (
          <StatsFieldCard
            profile={p}
            indexedBy={indexMap && indexMap.get(p.field)}
            dimmed={!!f && !matches(p)}
          />
        ))}
      </div>
    </div>
  );
}
