import { h, Fragment } from 'preact';
import { hasSpecial, tokenizeSpecial, cpLabel } from '../specialChars.js';

// Renders a record-value string, revealing special / invisible characters as
// labeled, color-coded markers (e.g. "NBSP", "ZWSP" — see specialChars.js). A
// clean string renders byte-identical to plain text. `quote` wraps the value in
// literal double quotes; `limit` truncates by source-character count, appending
// "..." — both matching displayValue's existing table behavior.
export default function SpecialText({ value, quote = false, limit }) {
  if (typeof value !== 'string') return value;
  const q = quote ? '"' : '';

  if (!hasSpecial(value)) {
    const s = (limit != null && value.length > limit) ? value.slice(0, limit) + '...' : value;
    return <Fragment>{q}{s}{q}</Fragment>;
  }

  const { tokens, truncated } = tokenizeSpecial(value, limit != null ? { limit } : {});
  return (
    <Fragment>
      {q}
      {tokens.map((t, i) => (
        t.type === 'text'
          ? t.value
          : <span key={i} class={'mdh-special mdh-special-' + t.category} title={cpLabel(t.cp) + ' ' + t.name}>{t.abbr}</span>
      ))}
      {truncated ? '...' : ''}
      {q}
    </Fragment>
  );
}
