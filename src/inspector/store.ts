import { signal } from '@preact/signals';

// Connection (set by the console shell before initInspector runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal<boolean | null>(null); // null = unprobed; true/false after whoami

// What annotation we're inspecting.
export const annotationId = signal<string | null>(null);

// Core report data + lazily-loaded best-effort enrichment + live re-eval result.
export const data = signal<any>(null); // { annotation, blocker, content, resolved }
/**
 * One lazily-loaded enrichment source: `null` until it is requested, then the loaded rows,
 * or the string 'unavailable' when the feature is off for this org (index.tsx:201).
 */
export type EnrichmentSource = any[] | 'unavailable' | null;

export type Enrichment = {
  audit: EnrichmentSource;
  hookLogs: EnrichmentSource;
  ruleLogs: EnrichmentSource;
  workflow: EnrichmentSource;
  notes: EnrichmentSource;
};

// The type parameter is load-bearing. Inferred from the initialiser this signal would be
// `Signal<{ audit: null; hookLogs: null; ... }>` — every field permanently null — and the
// only reason that ever type-checked is that index.tsx writes through a COMPUTED key
// (`{ ...value, [kind]: v }`), which TypeScript does not check against the target. So the
// whole enrichment flow was unchecked: the `Array.isArray` guards its readers already
// carry are the real contract, and this states it.
export const enrichment = signal<Enrichment>({
  audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null,
});
export const live = signal<any>(null); // { messages, matchedTriggerRules }

// Rossum Agent API ("Mr. Fabry") availability for AI attribution (probed at init).
export const aiAvailable = signal(false);
// Per-finding AI attribution state, keyed 'label:<id>' / 'reject'. Reset per annotation.
export const attributions = signal<Record<string, any>>({});
export function setAttribution(key: string, val: any) { attributions.value = { ...attributions.value, [key]: val }; }

// Progressive investigation lifecycle (spec §4.3).
const IDLE_INVESTIGATION = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
export const investigation = signal({ ...IDLE_INVESTIGATION });
export function setInvestigation(patch: Record<string, any>) { investigation.value = { ...investigation.value, ...patch }; }

// Narrative synthesis state (null until the synthesize stage starts).
export const synthesis = signal<any>(null);

// The evidence model, recomputed as sources land (pure buildEvidence output).
export const evidence = signal<any>(null);

// Document page previews for the right rail. Thumbnails are blob object URLs
// (page images 401 without the Bearer header) — revoked on annotation switch.
// null | { status: 'loading'|'done'|'error', total, pages: [{number,width,height,objectUrl}], rest: [pageResource] }
export const pagePreviews = signal<any>(null);
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
export const recents = signal<any[]>([]);

export const loading = signal(false);
export const error = signal<string | null>(null);

function emptyEnrichment(): Enrichment {
  return { audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null };
}

export function setAnnotationId(id: string | null) {
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
