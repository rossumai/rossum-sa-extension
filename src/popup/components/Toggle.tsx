import { h, Fragment } from 'preact';

export default function Toggle(
  { id, label, hint, beta, checked, onChange }:
  {
    id: string; label: string; hint?: string; beta?: boolean;
    checked?: boolean; onChange: (next: boolean) => void;
  },
) {
  return (
    <label class="toggle">
      <input
        type="checkbox"
        id={id}
        checked={!!checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="toggle-track"></span>
      <span class="toggle-label">
        {label}
        {beta ? <Fragment>{' '}<span class="beta-badge">beta</span></Fragment> : null}
        {hint ? <span class="toggle-hint">{hint}</span> : null}
      </span>
    </label>
  );
}
