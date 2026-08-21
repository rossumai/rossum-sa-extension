import { h } from 'preact';
import { friendlyType, rangeBar, spanBar, buildValueFilterPipeline } from '../statsView.js';
import { FieldName, formatDate, formatValue, FormattedValue, isSpecialValue } from './StatsBits.jsx';
import { selectedCollection, activePanel, pendingPipelineLoad, limit } from '../store.js';
import Tip from '../../ui/Tip.jsx';

function humanSpan(ms: any) {
  const day = 86400000;
  if (ms >= 365 * day) return `${(ms / (365 * day)).toFixed(1)} yr`;
  if (ms >= day) return `${Math.round(ms / day)} d`;
  return '< 1 d';
}

// Jump from a Stats card's top value to the matching records: stage a one-stage
// $match pipeline and switch to the data view, which consumes pendingPipelineLoad.
function filterToRecords(field: any, value: any, isPlaceholder: any) {
  const collection = selectedCollection.value;
  if (!collection) return;
  pendingPipelineLoad.value = { collection, pipelineText: buildValueFilterPipeline(field, value, isPlaceholder, limit.value) };
  activePanel.value = 'data';
}

function TypeChip({ profile }: { profile: any }) {
  if (profile.isMixed) {
    const label = profile.types.slice(0, 2).map((t: any) => friendlyType(t.type)).join(' + ')
      + (profile.types.length > 2 ? ` +${profile.types.length - 2}` : '');
    return <span class="stats-tchip is-mix">{label}</span>;
  }
  const f = friendlyType(profile.primaryType);
  const cls = f === 'number' ? ' is-num' : f === 'date' ? ' is-date' : '';
  return <span class={`stats-tchip${cls}`}>{f}</span>;
}

// Numeric min–max range bar with an avg tick (a mini chart, no detailed text).
function NumericRange({ n }: { n: any }) {
  const rb = rangeBar({ min: n.min, max: n.max, value: n.avg });
  return (
    <div class="stats-rangebar">
      <div class="stats-rangebar-track">
        <div class="stats-rangebar-seg" />
        {rb && rb.avgPct != null && <div class="stats-rangebar-avg" style={{ left: `${rb.avgPct}%` }} />}
      </div>
      <div class="stats-rangebar-ends"><span>min {n.min.toLocaleString()}</span><span>max {n.max.toLocaleString()}</span></div>
    </div>
  );
}

// Date earliest–latest span bar (a mini chart).
function DateRange({ d }: { d: any }) {
  return (
    <div class="stats-rangebar">
      <div class="stats-rangebar-track"><div class="stats-rangebar-seg" /></div>
      <div class="stats-rangebar-ends"><span>{formatDate(d.earliest)}</span><span>{formatDate(d.latest)}</span></div>
    </div>
  );
}

// Top values as a mini bar chart (shown on every card). Placeholder/sentinel
// values ("n/a", "none", …) are flagged in danger styling, and any that fall
// outside the top values are pinned in so a buried placeholder is still visible.
function TopValues({ profile, limit }: { profile: any; limit?: number }) {
  const isDate = !!profile.date;
  const base = (profile.topValues || []).slice(0, limit);
  const tokens = (profile.sentinel && profile.sentinel.values) || [];
  const tokenSet = new Set(tokens.map((s: any) => s.value));
  const norm = (v: any) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
  const shownTokens = new Set(base.map((v: any) => norm(v.value)).filter((t: any) => t && tokenSet.has(t)));
  const pinned = tokens.filter((s: any) => !shownTokens.has(s.value)).map((s: any) => ({ value: s.value, count: s.count, placeholder: true }));
  const rows = [...base.map((v: any) => ({ ...v, placeholder: tokenSet.has(norm(v.value)) })), ...pinned];
  if (rows.length === 0) return null;
  const max = rows.reduce((m, r) => Math.max(m, r.count), 1);
  return (
    <div class="stats-tv">
      {rows.map((v) => {
        const display = isDate ? formatDate(v.value) : formatValue(v.value);
        return (
          <div
            class={`stats-tv-row is-clickable${v.placeholder ? ' is-placeholder' : ''}`}
            title={`Show records where ${profile.field} = ${display}`}
            onClick={() => filterToRecords(profile.field, v.value, v.placeholder)}
          >
            <div class="stats-tv-bar" style={{ width: `${Math.round((v.count / max) * 100)}%` }} />
            <span class={`stats-tv-val${isSpecialValue(v.value) ? ' stats-dist-special' : ''}`}>
              {isDate ? display : <FormattedValue value={v.value} />}
            </span>
            <span class="stats-tv-count">{v.count.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function StatsFieldCard(
  { profile, indexedBy, dimmed }: { profile: any; indexedBy?: any; dimmed?: boolean },
) {
  const indexed = Array.isArray(indexedBy) && indexedBy.length > 0;
  const flagged = !!(
    (profile.sentinel && profile.sentinel.total > 0) || profile.isMixed
    || (profile.string && (profile.string.leading > 0 || profile.string.trailing > 0))
    || (profile.nullCount + profile.missingCount + profile.emptyCount) > 0
  );
  const dateSpan = profile.date ? spanBar(profile.date.earliest, profile.date.latest) : null;
  // Field issues — shown at the bottom of the card as warning/error messages
  // (badges are reserved for the header chips). Coverage gap = null/missing/empty.
  const gapBits = [];
  if (profile.nullCount) gapBits.push(`${profile.nullCount.toLocaleString()} null`);
  if (profile.missingCount) gapBits.push(`${profile.missingCount.toLocaleString()} missing`);
  if (profile.emptyCount) gapBits.push(`${profile.emptyCount.toLocaleString()} empty`);
  const wsBits = [];
  if (profile.string && profile.string.leading > 0) wsBits.push(`leading ×${profile.string.leading.toLocaleString()}`);
  if (profile.string && profile.string.trailing > 0) wsBits.push(`trailing ×${profile.string.trailing.toLocaleString()}`);
  const hasSentinel = !!(profile.sentinel && profile.sentinel.total > 0);
  const hasMsgs = hasSentinel || gapBits.length > 0 || wsBits.length > 0;
  // Height budget: fill the card to a consistent height by showing more top
  // values when there's no mini chart / no messages, fewer when those take room.
  const hasMiniChart = !!profile.numeric || !!profile.date;
  const messageCount = (hasSentinel ? 1 : 0) + (gapBits.length > 0 ? 1 : 0) + (wsBits.length > 0 ? 1 : 0);
  const topLimit = Math.max(3, 8 - (hasMiniChart ? 2 : 0) - Math.round(messageCount * 1.5));
  return (
    <div class={`stats-fcard${flagged ? ' is-flagged' : ''}${dimmed ? ' is-dimmed' : ''}`} id={`stats-field-${profile.field}`}>
      <div class="stats-fcard-h">
        <FieldName path={profile.field} />
        {indexed && (
          <Tip text={`Indexed — leading key of: ${indexedBy.join(', ')}`}>
            <span class="stats-idx-chip">indexed</span>
          </Tip>
        )}
        <TypeChip profile={profile} />
      </div>
      {profile.numeric && (
        <Tip block text={`avg ${profile.numeric.avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}>
          <NumericRange n={profile.numeric} />
        </Tip>
      )}
      {profile.date && (
        <Tip block text={`duration: ${dateSpan ? humanSpan(dateSpan.ms) : '—'}`}>
          <DateRange d={profile.date} />
        </Tip>
      )}
      <TopValues profile={profile} limit={topLimit} />
      {hasMsgs && (
        <div class="stats-msgs">
          {hasSentinel && (
            <div class="stats-msg is-error">
              <b>Placeholder</b> {profile.sentinel.values.slice(0, 2).map((s: any) => `"${s.value}" ×${s.count.toLocaleString()}`).join(' · ')}
              {profile.sentinel.values.length > 2 ? ` +${profile.sentinel.values.length - 2}` : ''}
            </div>
          )}
          {gapBits.length > 0 && <div class="stats-msg is-warn"><b>Incomplete</b> {gapBits.join(' · ')}</div>}
          {wsBits.length > 0 && <div class="stats-msg is-warn"><b>Whitespace</b> {wsBits.join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}
