import { h, Fragment } from 'preact';
import { getEjsonType, formatEjsonValue } from '../displayValue.js';

// Shared presentational controls for the MDH import/export wizards (Segmented
// pill group, Toggle switch, CsvPreview table). Extracted from the former
// per-format CSV import wizard (now removed) so the unified ImportWizard and
// export-options modals share one source.

// Segmented pill group. options: [{ value, label, title?, testid? }].
// `testid` (on the wrapper) is optional; per-option `testid` lands on each button.
export function Segmented({ value, options, onChange, testid, ariaLabel, tabs }) {
  return (
    <span class={`csv-seg${tabs ? ' seg-tabs' : ''}`} role="group" aria-label={ariaLabel} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={`csv-seg-opt${o.value === value ? ' on' : ''}`}
          title={o.title}
          data-testid={o.testid}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >{o.label}</button>
      ))}
    </span>
  );
}

// Toggle switch backed by an accessible button. Forwards `testid` to the button.
export function Toggle({ checked, onChange, title, testid }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      data-testid={testid}
      class={`csv-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span class="csv-switch-knob"></span>
    </button>
  );
}

export function CsvPreview({ parsed, limit = 10 }) {
  if (!parsed) return null;
  const { columns = [], docs = [], warnings = [], error } = parsed;
  if (error) {
    return (
      <div class="csv-error" data-testid="csv-error">
        Parse error{error.line ? ` (line ${error.line})` : ''}: {error.message}
      </div>
    );
  }
  const shown = docs.slice(0, limit);
  return (
    <div class="csv-preview" data-testid="csv-preview">
      {docs.length > 0 && (
        <div class="csv-preview-caption">
          <span>Preview {'·'} first {Math.min(limit, docs.length)} of {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'} {'·'} {columns.length} column{columns.length === 1 ? '' : 's'}</span>
          <span class="csv-preview-legend">
            <span class="csv-legend-num">123</span> number {'·'} <span class="csv-legend-str">text</span> {'·'} <span class="csv-legend-null">null</span>
          </span>
        </div>
      )}
      {docs.length === 0 ? (
        <div class="csv-preview-empty">No data rows found.</div>
      ) : (
        <div class="csv-preview-scroll">
          <table class="csv-preview-table">
            <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {shown.map((doc, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}><PreviewValue value={doc[c]} present={Object.prototype.hasOwnProperty.call(doc, c)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {warnings.map((w, i) => <div key={i} class="csv-warning" data-testid="csv-warning">{'⚠'} {w}</div>)}
    </div>
  );
}

function PreviewValue({ value, present }) {
  if (!present) return <span class="csv-cell-missing" title="field omitted">{'—'}</span>;
  if (value === null) return <span class="csv-cell-null">null</span>;
  if (typeof value === 'number') return <span class="csv-cell-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="csv-cell-bool">{String(value)}</span>;
  if (value === '') return <span class="csv-cell-empty" title="empty string">(empty)</span>;
  // Objects (e.g. an Excel date cell parsed to EJSON {$date}, or {$oid}) — render
  // their human form so the value is visible instead of a blank cell.
  if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    return <span class="csv-cell-string">{ejson ? formatEjsonValue(value, ejson) : JSON.stringify(value)}</span>;
  }
  return <span class="csv-cell-string">{value}</span>;
}
