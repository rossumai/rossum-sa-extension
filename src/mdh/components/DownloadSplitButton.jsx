import { h } from 'preact';
import { useState } from 'preact/hooks';

// Toolbar dropdown for the two download modes — raw collection vs. the
// result of the current pipeline. Matches the visual pattern of BulkSplitButton:
// a caret-only toggle with no primary action; both actions live in the menu.
export default function DownloadSplitButton({ onAll, onFiltered }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="dropdown-btn">
      <button
        class="btn btn-sm"
        title="Download collection as JSON"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        Download {'▾'}
      </button>
      {open && (
        <div class="toolbar-more-menu">
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); onAll(); }}>
            Download all{'…'}
          </button>
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); onFiltered(); }}>
            Download filtered{'…'}
          </button>
        </div>
      )}
    </div>
  );
}
