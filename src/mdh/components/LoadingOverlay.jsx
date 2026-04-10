import { h } from 'preact';
import { loading } from '../store.js';

export default function LoadingOverlay() {
  if (!loading.value) return null;
  return <div class="loading-overlay"><div class="spinner"></div></div>;
}
