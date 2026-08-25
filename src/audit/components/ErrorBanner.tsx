import { h } from 'preact';
import { error } from '../store.js';

export default function ErrorBanner() {
  if (!error.value) return null;
  return (
    <div class="error-banner">
      <span>{error.value}</span>
      <button class="dismiss" onClick={() => (error.value = null)}>
        {'×'}
      </button>
    </div>
  );
}
