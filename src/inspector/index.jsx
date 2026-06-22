import * as api from './api.js';
import * as store from './store.js';
import { extractLabelRules, extractLabelHooks } from './culprit.js';

let loadId = 0;
const safe = (fn) => Promise.resolve().then(fn).catch(() => null);
function idFromUrl(url) { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; }

export async function initInspector() {
  try { await api.whoami(); }
  catch (err) { store.error.value = err.message || 'Failed to verify session'; store.connected.value = false; return; }
  store.connected.value = true;
  if (store.annotationId.value) loadAnnotation(store.annotationId.value); // not awaited
}

export async function loadAnnotation(id) {
  const myId = ++loadId;
  store.loading.value = true;
  store.error.value = null;
  try {
    const annotation = await api.getAnnotation(id);
    if (myId !== loadId) return;
    const [blocker, content, queue, schema, document] = await Promise.all([
      annotation.automation_blocker ? safe(() => api.getAutomationBlocker(annotation.automation_blocker)) : Promise.resolve(null),
      safe(() => api.getContent(id)),
      annotation.queue ? safe(() => api.getQueue(annotation.queue)) : Promise.resolve(null),
      annotation.schema ? safe(() => api.getSchema(annotation.schema)) : Promise.resolve(null),
      annotation.document ? safe(() => api.getDocument(annotation.document)) : Promise.resolve(null),
    ]);
    if (myId !== loadId) return;

    // Resolve the few users we name (rejected_by, modifier) — best-effort.
    const usersById = {};
    const userUrls = [annotation.rejected_by, annotation.modifier].filter(Boolean);
    await Promise.all(userUrls.map((u) => safe(() => api.getUser(u)).then((usr) => { if (usr) usersById[idFromUrl(u)] = usr; })));
    if (myId !== loadId) return;

    store.data.value = { annotation, blocker, content, resolved: { queue, schema, document, usersById, hooksById: {}, rulesById: {} } };
  } catch (err) {
    if (myId === loadId) store.error.value = err.message || 'Failed to load annotation';
  } finally {
    if (myId === loadId) store.loading.value = false;
  }
}

// Lazily fetch a best-effort enrichment collection into store.enrichment[kind].
export async function loadEnrichment(kind) {
  const id = store.annotationId.value;
  const fns = {
    notes: () => api.listNotes(id),
    workflow: () => api.listWorkflowActivities(id),
    audit: () => api.listAuditLogs(id),
    hookLogs: () => api.listHookLogs(id),
    ruleLogs: () => api.listRuleExecutionLogs(id),
  };
  if (!fns[kind]) return;
  try {
    const v = await fns[kind]();
    store.enrichment.value = { ...store.enrichment.value, [kind]: v };
  } catch (err) {
    store.enrichment.value = { ...store.enrichment.value, [kind]: err.featureUnavailable ? 'unavailable' : [] };
  }
}

// For the rejection detective: populate resolved.hooksById from the queue's hooks.
export async function loadQueueHooks() {
  const d = store.data.value;
  if (!d || !d.annotation.queue || d.resolved._hooksLoaded) return;
  const hooks = await safe(() => api.listHooks(idFromUrl(d.annotation.queue))) || [];
  const hooksById = {};
  for (const hk of hooks) hooksById[hk.id] = hk;
  const cur = store.data.value;
  if (!cur) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, hooksById, _hooksLoaded: true } };
}

// For the "Why labels" tab: resolve label definitions + the queue's
// label-applying rules (best-effort), merged into resolved.
export async function loadLabelContext() {
  const d = store.data.value;
  if (!d) return;
  const queueId = idFromUrl(d.annotation.queue);
  const [labels, rules, hooks] = await Promise.all([
    safe(() => api.listLabels()),
    queueId ? safe(() => api.listRules(queueId)) : Promise.resolve(null),
    queueId ? safe(() => api.listHooks(queueId)) : Promise.resolve(null),
  ]);
  const labelsById = {};
  for (const l of labels || []) labelsById[String(l.id)] = { id: String(l.id), name: l.name, color: l.color, url: l.url };
  const labelRules = extractLabelRules(rules || []);
  const labelHooks = extractLabelHooks(hooks || []);
  const cur = store.data.value;
  if (!cur) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, labelsById, labelRules, labelHooks } };
}

// Opt-in live re-evaluate (the only write path).
export async function runRevalidate() {
  const id = store.annotationId.value;
  const res = await api.revalidate(id);
  store.live.value = { messages: res?.messages || [], matchedTriggerRules: res?.matched_trigger_rules || [] };
}
