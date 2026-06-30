import { h } from 'preact';

export function FieldName({ path }) {
  const parts = path.split('.');
  if (parts.length === 1) return <span class="stats-field-name">{path}</span>;
  const parent = parts.slice(0, -1).join('.');
  const leaf = parts[parts.length - 1];
  return (
    <span class="stats-field-name">
      <span class="stats-field-parent">{parent}.</span>{leaf}
    </span>
  );
}

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatDate(d) {
  if (!d) return '—';
  const s = typeof d === 'string' ? d : d.$date || String(d);
  try { return new Date(s).toISOString().split('T')[0]; } catch { return String(s); }
}

export function formatValue(v) {
  if (v === null) return 'null';
  if (v === '') return 'empty';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function isSpecialValue(v) {
  return v === null || v === '' || v === true || v === false || typeof v === 'undefined';
}

export function FormattedValue({ value }) {
  if (value === null) return <span class="stats-dist-special">null</span>;
  if (value === '') return <em class="stats-dist-special">empty</em>;
  if (value === true) return <span class="stats-dist-special">true</span>;
  if (value === false) return <span class="stats-dist-special">false</span>;
  if (typeof value === 'object') return <span class="stats-dist-object">{JSON.stringify(value)}</span>;
  return String(value);
}
