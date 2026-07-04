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
  audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null,
});
export const live = signal(null); // { messages, matchedTriggerRules }

// Rossum Agent API ("Mr. Fabry") availability for AI attribution (probed at init).
export const aiAvailable = signal(false);
// Per-finding AI attribution state, keyed 'label:<id>' / 'reject'. Reset per annotation.
export const attributions = signal({});
export function setAttribution(key, val) { attributions.value = { ...attributions.value, [key]: val }; }

// Progressive investigation lifecycle (spec §4.3).
const IDLE_INVESTIGATION = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
export const investigation = signal({ ...IDLE_INVESTIGATION });
export function setInvestigation(patch) { investigation.value = { ...investigation.value, ...patch }; }

// Narrative synthesis state (null until the synthesize stage starts).
export const synthesis = signal(null);

// The evidence model, recomputed as sources land (pure buildEvidence output).
export const evidence = signal(null);

// Document page previews for the right rail. Thumbnails are blob object URLs
// (page images 401 without the Bearer header) — revoked on annotation switch.
// null | { status: 'loading'|'done'|'error', total, pages: [{number,width,height,objectUrl}], rest: [pageResource] }
export const pagePreviews = signal(null);
export function clearPagePreviews() {
  const v = pagePreviews.value;
  if (v) {
    for (const p of v.pages || []) {
      try { if (p.objectUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(p.objectUrl); } catch { /* ignore */ }
    }
  }
  pagePreviews.value = null;
}

// Recently-inspected annotations (rich entries), most-recent-first, deduped by id.
// Persisted globally in chrome.storage.local via recents.js; loaded at init.
export const recents = signal([]);

export const loading = signal(false);
export const error = signal(null);

function emptyEnrichment() {
  return { audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null };
}

export function setAnnotationId(id) {
  annotationId.value = id;
  data.value = null;
  live.value = null;
  enrichment.value = emptyEnrichment();
  attributions.value = {};
  investigation.value = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
  synthesis.value = null;
  evidence.value = null;
  clearPagePreviews();
  error.value = null;
}

export function reset() {
  annotationId.value = null;
  data.value = null;
  live.value = null;
  enrichment.value = emptyEnrichment();
  attributions.value = {};
  investigation.value = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
  synthesis.value = null;
  evidence.value = null;
  clearPagePreviews();
  loading.value = false;
  error.value = null;
  connected.value = null;
}
