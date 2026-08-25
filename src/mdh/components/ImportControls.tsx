import { h, Fragment } from 'preact';
import { getEjsonType, formatEjsonValue } from '../displayValue.js';
import { getByPath, hasByPath } from '../flatten.js';

// Shared presentational controls for the MDH import/export wizards (Segmented
// pill group, Toggle switch, CsvPreview table). Extracted from the former
// per-format CSV import wizard (now removed) so the unified ImportWizard and
// export-options modals share one source.

// Segmented pill group. options: [{ value, label, title?, testid?, disabled? }].
// `testid` (on the wrapper) is optional; per-option `testid` lands on each button.
export function Segmented({
  value,
  options,
  onChange,
  testid,
  ariaLabel,
  tabs,
}: {
  value?: string;
  options: any[];
  onChange: (v: any) => void;
  testid?: string;
  ariaLabel?: string;
  tabs?: boolean;
}) {
  return (
    <span
      class={`csv-seg${tabs ? ' seg-tabs' : ''}`}
      role="group"
      aria-label={ariaLabel}
      data-testid={testid}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={`csv-seg-opt${o.value === value ? ' on' : ''}`}
          title={o.title}
          data-testid={o.testid}
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

// Toggle switch backed by an accessible button. Forwards `testid` to the button.
export function Toggle({
  checked,
  onChange,
  title,
  testid,
}: {
  checked?: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  testid?: string;
}) {
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

export function CsvPreview({
  parsed,
  limit = 5,
  nested = false,
}: {
  parsed: any;
  limit?: number;
  nested?: boolean;
}) {
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
          <span>
            Preview {'·'} first {Math.min(limit, docs.length)} of {docs.length.toLocaleString()} row
            {docs.length === 1 ? '' : 's'} {'·'} {columns.length} column
            {columns.length === 1 ? '' : 's'}
          </span>
          <span class="csv-preview-legend">
            <span class="csv-legend-num">123</span> number {'·'}{' '}
            <span class="csv-legend-str">text</span> {'·'} <span class="csv-legend-null">null</span>
          </span>
        </div>
      )}
      {docs.length === 0 ? (
        <div class="csv-preview-empty">No data rows found.</div>
      ) : (
        <div class="csv-preview-scroll">
          <table class="csv-preview-table">
            <thead>
              <tr>
                {columns.map((c: any) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((doc: any, i: any) => (
                <tr key={i}>
                  {columns.map((c: any) => {
                    // With restore on, docs are nested but the header is still the
                    // raw column — and the header IS the encoded path, so this is exact.
                    const value = nested ? getByPath(doc, c) : doc[c];
                    const present = nested
                      ? hasByPath(doc, c)
                      : Object.prototype.hasOwnProperty.call(doc, c);
                    return (
                      <td key={c}>
                        <PreviewValue value={value} present={present} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {warnings.map((w: any, i: any) => (
        <div key={i} class="csv-warning" data-testid="csv-warning">
          {'⚠'} {w}
        </div>
      ))}
    </div>
  );
}

const JSON_PREVIEW_ROWS = 5;

// Compact preview for column-less imports (JSON / JSON-lines): the first few
// docs as single-line JSON, in the same preview chrome as the export modal.
export function JsonPreview({ docs }: { docs: any[] }) {
  if (!docs.length) return null;
  const shown = docs.slice(0, JSON_PREVIEW_ROWS);
  return (
    <div class="csv-export-preview" data-testid="json-preview">
      <div class="csv-export-preview-caption">
        Preview {'·'} first {shown.length} of {docs.length.toLocaleString()} row
        {docs.length === 1 ? '' : 's'}
      </div>
      <pre class="csv-export-preview-text">{shown.map((d) => JSON.stringify(d)).join('\n')}</pre>
    </div>
  );
}

// Shared "this is a state, not a value" vocabulary (house rule: console.css
// .csv-cell-* — muted + italic, and a parenthesized word is the written
// signal that a cell describes an absence/emptiness rather than holding a
// real value). `null` is deliberately NOT part of this vocabulary: it is a
// real type name (shape.ts#typeOf returns 'null' for it), so it renders
// mono/plain wherever it appears as one — never italicised, never muted.
// Exported so ImportConfirm's ledger and ExportWizard's preview grid use the
// exact same three words instead of inventing their own.
export function AbsentValue() {
  return <span class="csv-cell-missing">(absent)</span>;
}

export function EmptyValue() {
  return (
    <span class="csv-cell-empty" title="empty string">
      (empty)
    </span>
  );
}

export function NullValue() {
  return <span class="csv-cell-null">null</span>;
}

// A present, non-object scalar — the one rendering PreviewValue and
// ExportWizard's cellPreview share. Objects stay separate in each caller on
// purpose: PreviewValue JSON-stringifies so the value is visible, while
// cellPreview uses displayValue's truncated/collapsed form — merging those
// would regress one of them.
export function ScalarValue({ value }: { value: string | number | boolean }) {
  if (typeof value === 'number') return <span class="csv-cell-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="csv-cell-bool">{String(value)}</span>;
  return <span class="csv-cell-string">{value}</span>;
}

function PreviewValue({ value, present }: { value: any; present?: boolean }) {
  if (!present) return <AbsentValue />;
  if (value === null) return <NullValue />;
  if (value === '') return <EmptyValue />;
  // Objects (e.g. an Excel date cell parsed to EJSON {$date}, or {$oid}) — render
  // their human form so the value is visible instead of a blank cell.
  if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    return (
      <span class="csv-cell-string">
        {ejson ? formatEjsonValue(value, ejson) : JSON.stringify(value)}
      </span>
    );
  }
  return <ScalarValue value={value} />;
}
