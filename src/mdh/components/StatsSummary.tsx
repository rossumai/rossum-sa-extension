import { h } from 'preact';
import { healthLabel } from '../statsSummary.js';
import { formatBytes } from './StatsBits.jsx';
import Tip from '../../ui/Tip.jsx';

const LARGE_COLLECTION_WARN = 100000;

function healthColor(score: any) {
  if (score >= 90) return 'var(--success)';
  if (score >= 75) return 'var(--accent)';
  if (score >= 50) return 'var(--warning)';
  return 'var(--danger)';
}

const COMPONENT_LABELS = [
  [
    'fieldCoverage',
    'Field coverage',
    'Average share of documents that have a real value (not null, missing, or empty), averaged across all fields.',
  ],
  [
    'typeConsistency',
    'Type consistency',
    'Share of fields whose values are all one data type. Mixing types (e.g. text and number) lowers this; whole vs. decimal numbers are both "number" and do not count as a mix.',
  ],
  [
    'valueCompleteness',
    'Value completeness',
    'Share of fields with no null, empty, missing, or placeholder values ("n/a", "none", "-", …).',
  ],
  [
    'whitespace',
    'Cleanliness',
    'Share of text fields with no leading or trailing whitespace — invisible spaces that make identical-looking values fail to match.',
  ],
  [
    'schema',
    'Schema',
    'Whether all documents share the same structure. Multiple field-count shapes (from merged imports or optional fields) lower this.',
  ],
];

function Ring({ health }: { health?: number | null }) {
  const tone = health != null ? healthColor(health) : 'var(--text-secondary)';
  const R = 44;
  const circ = 2 * Math.PI * R; // 276.46
  const off = health != null ? circ * (1 - health / 100) : circ;
  return (
    <div class="stats-ring">
      <svg width="104" height="104" viewBox="0 0 104 104">
        <circle cx="52" cy="52" r={R} fill="none" stroke="var(--bg-hover)" stroke-width="11" />
        {health != null && (
          <circle
            cx="52"
            cy="52"
            r={R}
            fill="none"
            stroke={tone}
            stroke-width="11"
            stroke-linecap="round"
            stroke-dasharray={circ}
            stroke-dashoffset={off}
            transform="rotate(-90 52 52)"
          />
        )}
      </svg>
      <div class="stats-ring-num">
        <b style={{ color: tone }}>{health != null ? health : '?'}</b>
        <span>/ 100</span>
      </div>
    </div>
  );
}

export default function StatsSummary({
  health,
  components,
  total,
  fieldCount,
  fieldsTotal,
  storage,
  docSize,
}: {
  health?: number | null;
  components?: any;
  /** Read unconditionally by the overview cards. */
  total: number;
  fieldCount: number;
  fieldsTotal: number;
  /** $collStats storage figures; each card is guarded on the object being present. */
  storage?: { size: number; freeStorageSize: number; storageSize: number } | null;
  docSize?: { min: number; max: number; avg: number } | null;
}) {
  const tone = health != null ? healthColor(health) : 'var(--text-secondary)';
  return (
    <div>
      <div class="stats-band-label">Summary</div>
      <div class="stats-dash">
        <div
          class="stats-health"
          title={health != null ? healthLabel(health) : `calculating${'…'}`}
        >
          <Ring health={health} />
          {health != null && (
            <div class="stats-health-label" style={{ color: tone }}>
              {healthLabel(health)}
            </div>
          )}
        </div>
        <div class="stats-dash-right">
          <div class="stats-overview-grid">
            <div class="stats-overview-card">
              <div class="stats-metric-value">{total.toLocaleString()}</div>
              <div class="stats-metric-label">Documents</div>
            </div>
            <div
              class="stats-overview-card"
              title={
                (fieldsTotal > fieldCount
                  ? `Analyzing the ${fieldCount} most common of ${fieldsTotal} fields found`
                  : null) as string | undefined
              }
            >
              <div class="stats-metric-value">{fieldCount}</div>
              <div class="stats-metric-label">Fields</div>
            </div>
            {storage && (
              <div
                class="stats-overview-card"
                title={`Logical: ${formatBytes(storage.size)} · Free: ${formatBytes(storage.freeStorageSize)}`}
              >
                <div class="stats-metric-value">{formatBytes(storage.storageSize)}</div>
                <div class="stats-metric-label">On disk</div>
              </div>
            )}
            {docSize && (
              <div
                class="stats-overview-card"
                title={`Min: ${formatBytes(docSize.min)} · Max: ${formatBytes(docSize.max)}`}
              >
                <div class="stats-metric-value">{formatBytes(docSize.avg)}</div>
                <div class="stats-metric-label">Avg doc</div>
              </div>
            )}
          </div>
          {fieldsTotal > fieldCount && (
            <div class="stats-fields-note">
              Analyzing the {fieldCount} most common of {fieldsTotal} fields found in the sample.
            </div>
          )}
          {components && (
            <div class="stats-hcomp-wrap">
              {[COMPONENT_LABELS.slice(0, 3), COMPONENT_LABELS.slice(3)].map((group) => (
                <div class="stats-hcomp">
                  {group.map(([key, label, tip]) => {
                    const v = Math.round(components[key]);
                    const c = healthColor(v);
                    return (
                      <div class="stats-hcomp-row">
                        <span class="stats-hcomp-label">
                          {label}
                          <Tip text={tip}>
                            <span class="stats-help">?</span>
                          </Tip>
                        </span>
                        <div class="stats-hbar">
                          <i style={{ width: `${v}%`, background: c }} />
                        </div>
                        <span class="stats-hcomp-val">{v}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {total > LARGE_COLLECTION_WARN && (
        <div class="stats-warn" style={{ marginTop: '10px' }}>
          This collection has {total.toLocaleString()} documents. Some checks may be slow or time
          out.
        </div>
      )}
    </div>
  );
}
