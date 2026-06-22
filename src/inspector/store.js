import { signal } from '@preact/signals';

// Connection (set by the console shell before initInspector runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = unprobed; true/false after whoami

// What annotation we're inspecting.
export const annotationId = signal(null);

// Core report data + lazily-loaded best-effort enrichment + live re-eval result.
export const data = signal(null); // { annotation, blocker, content, resolved }
export const enrichment = signal({
  audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null,
});
export const live = signal(null); // { messages, matchedTriggerRules }

export const loading = signal(false);
export const error = signal(null);

function emptyEnrichment() {
  return { audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null };
}

// Persist the inspected annotation per-tab so it survives a Console page refresh
// (same mechanism as the session token/domain). node-safe (sessionStorage absent).
const ANN_KEY = 'consoleInspectorAnn';
export function persistAnnotationId(id) {
  try { if (typeof sessionStorage !== 'undefined' && id != null && id !== '') sessionStorage.setItem(ANN_KEY, String(id)); } catch { /* ignore */ }
}
export function restoreAnnotationId() {
  try { if (typeof sessionStorage !== 'undefined') return sessionStorage.getItem(ANN_KEY); } catch { /* ignore */ }
  return null;
}

export function setAnnotationId(id) {
  annotationId.value = id;
  data.value = null;
  live.value = null;
  enrichment.value = emptyEnrichment();
  error.value = null;
  persistAnnotationId(id);
}

export function reset() {
  annotationId.value = null;
  data.value = null;
  live.value = null;
  enrichment.value = emptyEnrichment();
  loading.value = false;
  error.value = null;
  connected.value = null;
}
