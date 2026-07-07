import { h } from 'preact';
import { useState } from 'preact/hooks';

// One-sentence outcome+risk summary with a collapsed "Details" expander that
// holds the full verified bullet list (the caller passes the <ul>). Replaces
// the always-visible "What will happen" blocks in the import/export wizards.
// Collapsed on every mount; expansion is never persisted.
export default function PlanSummary({ summary, summaryTestid, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="plan-summary">
      <div class="plan-summary-line">
        <span class="plan-summary-text" data-testid={summaryTestid}>{summary}</span>
        {children && (
          <button
            type="button"
            class="plan-summary-toggle"
            aria-expanded={open}
            data-testid={summaryTestid ? `${summaryTestid}-toggle` : undefined}
            onClick={() => setOpen(!open)}
          >{open ? 'Hide ▴' : 'Details ▾'}</button>
        )}
      </div>
      {open && <div class="import-steps">{children}</div>}
    </div>
  );
}
