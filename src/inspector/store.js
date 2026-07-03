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

// Rossum Agent API ("Mr. Fabry") availability for AI attribution (probed at init).
export const aiAvailable = signal(false);
// Per-finding AI attribution state, keyed 'label:<id>' / 'reject'. Reset per annotation.
export const attributions = signal({});
export function setAttribution(key, val) { attributions.value = { ...attributions.value, [key]: val }; }

// Recently-inspected annotations (rich entries), most-recent-first, deduped by id.
// Persisted globally in chrome.storage.local via recents.js; loaded at init.
export const recents = signal([]);

export const loading = signal(false);
export const error = signal(null);

function emptyEnrichment() {
  return { audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null };
}

export function setAnnotationId(id) {
  annotationId.value = id;
  data.value = null;
  live.value = null;
  enrichment.value = emptyEnrichment();
  attributions.value = {};
  error.value = null;
}

export function reset() {
  annotationId.value = null;
  data.value = null;
  live.value = null;
  enrichment.value = emptyEnrichment();
  attributions.value = {};
  loading.value = false;
  error.value = null;
  connected.value = null;
}
