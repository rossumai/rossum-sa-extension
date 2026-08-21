import { h } from 'preact';
import { error } from '../store.js';

export default function ErrorBanner() {
  const err = error.value;
  if (!err) return null;

  return (
    <div class="error-banner">
      <span>{err.message}</span>
      <button class="dismiss" onClick={() => { error.value = null; }}>{'\u00d7'}</button>
    </div>
  );
}
