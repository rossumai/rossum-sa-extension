import { h } from 'preact';
import { opNotice } from '../store.js';

// Non-error operation notice shown as a full-width top stripe (sibling to
// ErrorBanner): info while an async op runs, warning when its outcome is
// inconclusive. Failures use the red ErrorBanner instead.
export default function OpNoticeBanner() {
  const notice = opNotice.value;
  if (!notice) return null;

  return (
    <div class={'op-notice-banner ' + (notice.kind || 'info')}>
      <span>{notice.message}</span>
      <button
        class="dismiss"
        onClick={() => {
          opNotice.value = null;
        }}
      >
        {'×'}
      </button>
    </div>
  );
}
