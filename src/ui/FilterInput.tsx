import { h } from 'preact';
import styles from './FilterInput.module.css';

// Shared filter/search input (design system). The call site hands over a value and gets back
// typed text as a STRING — no `e.target.value` reader per consumer — plus a clear button it
// only has to wire, and one place where the box's height and font are decided.
//
// `active` is what counts as "engaged", and it drives the accent state and the clear button
// together. It is a prop rather than a derived `value !== ''` because the two consumers
// genuinely disagree: the sidebar's matcher trims, so whitespace-only is not filtering, while
// the uploads filter matches a bare space. Defaults to a non-empty value.
//
// `className` lands on the wrap, for width only — see the module header.
export default function FilterInput({
  value,
  onInput,
  onClear,
  active,
  placeholder,
  ariaLabel,
  title,
  onKeyDown,
  className,
}: {
  value: string;
  onInput: (value: string) => void;
  onClear: () => void;
  active?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  className?: string;
}) {
  const engaged = active === undefined ? value !== '' : active;
  const wrap =
    styles.wrap + (engaged ? ' ' + styles.hasValue : '') + (className ? ' ' + className : '');
  return (
    <div class={wrap}>
      <svg
        class={styles.icon}
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        class={styles.input}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        title={title}
        // Annotated because the body reads `e.target`, which `e.currentTarget` is not.
        onInput={(e: any) => onInput(e.target.value)}
        // Passed straight through, never wrapped: the sidebar's Escape must keep reaching
        // document-level listeners.
        onKeyDown={onKeyDown}
      />
      {engaged && (
        <button
          class={styles.clear}
          title="Clear filter"
          aria-label="Clear filter"
          onClick={onClear}
        >
          {'×'}
        </button>
      )}
    </div>
  );
}
