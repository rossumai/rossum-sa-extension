import { h } from 'preact';
import GerundLoader from '../GerundLoader.jsx';
import FabryMark from '../FabryMark.jsx';
import styles from '../aiInput.module.css';

// Controlled Fabry ask input (MDH visual design): ✦ spark + rounded input +
// gerund loader while busy. Store-agnostic — the parent owns value/submit.
// `size="sm"` renders the compact form used inside Inspector/Audit and the MDH
// transcript's continue box (replaces the old .inspector-ask/.audit-fabry overrides).
export default function FabryInput({
  value, onInput, onSubmit, busy, disabled, placeholder, gerunds, size, className,
}: {
  value?: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  gerunds: string[];
  size?: string;
  className?: string;
}) {
  const row = styles.row + (size === 'sm' ? ' ' + styles.sm : '') + (className ? ' ' + className : '');
  return (
    <div class={row}>
      <div class={styles.wrapper}>
        <span class={styles.spark + (busy ? ' ' + styles.loading : '')}><FabryMark /></span>
        <input
          class={styles.input + (busy ? ' ' + styles.loading : '')}
          type="text"
          placeholder={placeholder}
          value={busy ? '' : value}
          disabled={busy || disabled}
          onInput={(e: any) => onInput(e.target.value)}
          onKeyDown={(e: any) => { if (e.key === 'Enter') onSubmit(e.target.value); if (e.key === 'Escape') onInput(''); }}
        />
        {busy && <GerundLoader gerunds={gerunds} />}
      </div>
    </div>
  );
}
