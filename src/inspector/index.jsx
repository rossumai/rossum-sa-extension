import * as api from './api.js';
import * as store from './store.js';
import { track } from '../usage/track.js';
import { extractLabelRules } from './culprit.js';
import { loadRecents, enrichRecents } from './recents.js';
import { VIEWED_KEY } from './viewed.js';
import * as agentApi from '../agent/agentApi.js';
import { orchestrateAttributions } from './orchestrate.js';
import { buildEvidence } from './evidence.js';
import { runSynthesis, continueSynthesis } from './synthesize.js';

let loadId = 0;
const safe = (fn) => Promise.resolve().then(fn).catch(() => null);
function idFromUrl(url) { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; }

// Prefetch all enrichment + queue hooks/labels/rules/intake/workflow context (all
// 403-tolerant), then run the attribution orchestrator, then (agent permitting) the
// narrative synthesis. Drives investigation.stage through gathering → attributing →
// synthesizing → complete (or agent-offline). Aborts any prior in-flight run
// (superseded by a newer annotation load) so it never writes a stale result.
let attrController = null;
// The agent health probe, kicked off once in initInspector. Held as a promise so
// prefetchAndOrchestrate can AWAIT it before deciding "agent offline" — otherwise a
// fast gather reads the default-false aiAvailable while the probe is still in flight
// and wrongly skips synthesis (the probe's .then sets aiAvailable exactly once).
let aiProbe = null;
const SOURCES = ['workflow', 'notes', 'hookLogs', 'ruleLogs', 'hooks', 'labels', 'rules', 'workflowCtx', 'intakeCtx'];
async function prefetchAndOrchestrate() {
  track('sa_inspector_report');
  if (attrController) attrController.abort();
  attrController = new AbortController();
  const signal = attrController.signal;
  store.setInvestigation({ stage: 'gathering', sourcesDone: 0, sourcesTotal: SOURCES.length, activity: '' });
  const tick = (p) => p.then(() => { if (!signal.aborted) { store.setInvestigation({ sourcesDone: store.investigation.value.sourcesDone + 1 }); recomputeEvidence(); } })
    .catch(() => { if (!signal.aborted) { store.setInvestigation({ sourcesDone: store.investigation.value.sourcesDone + 1 }); } });
  await Promise.all([
    tick(loadEnrichment('workflow')), tick(loadEnrichment('notes')),
    tick(loadEnrichment('hookLogs')), tick(loadEnrichment('ruleLogs')),
    tick(loadQueueHooks()), tick(loadLabelContext()), tick(loadQueueRules()),
    tick(loadWorkflowContext()), tick(loadIntakeContext()),
  ]);
  if (signal.aborted) return;
  // Settle the agent health probe BEFORE attribution AND synthesis: a fast gather
  // must not run orchestrateAttributions (which skips the whole AI tier when
  // aiAvailable is false — orchestrate.js:110) OR the offline decision on a
  // still-default value. The probe starts in initInspector, so this is normally
  // already resolved (no stall); a slow/hung /health is bounded by probeAgent's 10s.
  if (aiProbe) { await aiProbe; if (signal.aborted) return; }
  store.setInvestigation({ stage: 'attributing' });
  await orchestrateAttributions({ store, api, agentApi, signal });
  if (signal.aborted) return;
  recomputeEvidence();
  if (!store.aiAvailable.value) {
    store.synthesis.value = { status: 'offline', text: '', reasoning: '', tools: [], error: null };
    store.setInvestigation({ stage: 'agent-offline', activity: '' });
    return;
  }
  store.setInvestigation({ stage: 'synthesizing' });
  store.synthesis.value = { status: 'streaming', text: '', reasoning: '', tools: [], error: null };
  try {
    const a = store.data.value?.annotation || {};
    const res = await runSynthesis({
      agentApi, evidence: store.evidence.value,
      annotation: { id: a.id, status: a.status, queueId: idFromUrl(a.queue) },
      signal,
      onPhase: (p) => { if (!signal.aborted) store.setInvestigation({ activity: p }); },
      onText: (t) => { if (!signal.aborted) store.synthesis.value = { ...store.synthesis.value, text: t }; },
    });
    if (signal.aborted) return;
    store.synthesis.value = { status: 'done', text: res.text, reasoning: res.reasoning, tools: res.tools, chatId: res.chatId, followups: [], error: null };
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    store.synthesis.value = { ...store.synthesis.value, status: 'error', error: e?.message || 'synthesis failed' };
  }
  store.setInvestigation({ stage: 'complete', activity: '' });
}

let viewedListenerOn = false;

export async function initInspector() {
  loadRecents(); // fire-and-forget; recents show even in the not-connected view
  // Live landing: a visit recorded by the content script (any tab) refreshes the
  // list here without a reload. Registered once; storage errors are non-fatal.
  if (!viewedListenerOn && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    viewedListenerOn = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[VIEWED_KEY]) return;
        loadRecents().then(() => { if (store.connected.value) return enrichRecents(api); }).catch(() => {});
      });
    } catch { /* ignore */ }
  }
  try { await api.whoami(); }
  catch (err) { store.error.value = err.message || 'Failed to verify session'; store.connected.value = false; return; }
  store.connected.value = true;
  enrichRecents(api).catch(() => {}); // resolve names for the viewed list (non-blocking)
  // Non-blocking, but held so prefetchAndOrchestrate can await it (avoids the
  // fast-gather → false agent-offline race). Sets aiAvailable exactly once.
  aiProbe = agentApi.probeAgent().then((ok) => { store.aiAvailable.value = ok; return ok; }).catch(() => false);
  if (store.annotationId.value) loadAnnotation(store.annotationId.value); // not awaited
}

export async function loadAnnotation(id) {
  const myId = ++loadId;
  if (attrController) attrController.abort();
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
    recomputeEvidence(); // skeleton evidence + verdict render before enrichment lands
    prefetchAndOrchestrate().catch(() => {}); // not awaited; swallow (attribution is best-effort)
    loadPagePreviews().catch(() => {}); // not awaited; decoration, not an investigation source
  } catch (err) {
    if (myId === loadId) store.error.value = err.message || 'Failed to load annotation';
  } finally {
    if (myId === loadId) store.loading.value = false;
  }
}

// --- document page previews (right rail) -------------------------------------
// Page images 401 without the Bearer header, so each thumbnail is fetched as a
// Blob and shown via an object URL (revoked by the store on annotation switch).
const PAGE_PREVIEW_LIMIT = 4;

async function fetchPreviewBatch(pageResources, myId) {
  for (const p of pageResources) {
    if (myId !== loadId) return;
    const blob = await safe(() => api.getBlob(p.content));
    if (myId !== loadId) return;
    const objectUrl = blob && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null;
    const cur = store.pagePreviews.value;
    if (!cur) return; // cleared by an annotation switch
    store.pagePreviews.value = { ...cur, pages: [...cur.pages, { number: p.number, width: p.width, height: p.height, objectUrl }] };
  }
}

export async function loadPagePreviews() {
  const id = store.annotationId.value;
  const myId = loadId;
  store.pagePreviews.value = { status: 'loading', total: 0, pages: [], rest: [] };
  try {
    const list = (await api.listPages(id)) || [];
    if (myId !== loadId) return;
    const sorted = [...list].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    if (!sorted.length) { store.pagePreviews.value = { status: 'done', total: 0, pages: [], rest: [] }; return; }
    store.pagePreviews.value = { status: 'loading', total: sorted.length, pages: [], rest: sorted.slice(PAGE_PREVIEW_LIMIT) };
    await fetchPreviewBatch(sorted.slice(0, PAGE_PREVIEW_LIMIT), myId);
    if (myId !== loadId) return;
    const cur = store.pagePreviews.value;
    if (cur) store.pagePreviews.value = { ...cur, status: 'done' };
  } catch {
    if (myId === loadId) store.pagePreviews.value = { status: 'error', total: 0, pages: [], rest: [] };
  }
}

// "Load N more pages" — fetches the remainder (user-initiated).
export async function loadAllPagePreviews() {
  const myId = loadId;
  const cur = store.pagePreviews.value;
  if (!cur || !cur.rest || cur.rest.length === 0) return;
  const rest = cur.rest;
  store.pagePreviews.value = { ...cur, rest: [] };
  await fetchPreviewBatch(rest, myId);
}

// Lazily fetch a best-effort enrichment collection into store.enrichment[kind].
export async function loadEnrichment(kind) {
  const id = store.annotationId.value;
  const myId = loadId; // bail before writing if the user navigated to another annotation
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
    if (myId !== loadId) return;
    store.enrichment.value = { ...store.enrichment.value, [kind]: v };
  } catch (err) {
    if (myId !== loadId) return;
    store.enrichment.value = { ...store.enrichment.value, [kind]: err.featureUnavailable ? 'unavailable' : [] };
  }
}

// For the rejection detective: populate resolved.hooksById from the queue's hooks.
export async function loadQueueHooks() {
  const d = store.data.value;
  if (!d || !d.annotation.queue || d.resolved._hooksLoaded) return;
  const myId = loadId;
  const hooks = await safe(() => api.listHooks(idFromUrl(d.annotation.queue))) || [];
  const hooksById = {};
  for (const hk of hooks) hooksById[hk.id] = hk;
  const cur = store.data.value;
  if (!cur || myId !== loadId) return; // superseded by a newer annotation → don't contaminate it
  store.data.value = { ...cur, resolved: { ...cur.resolved, hooksById, _hooksLoaded: true } };
}

// For the "Why labels" tab: resolve label definitions + the queue's
// label-applying rules (best-effort), merged into resolved.
export async function loadLabelContext() {
  const d = store.data.value;
  if (!d) return;
  const myId = loadId;
  const queueId = idFromUrl(d.annotation.queue);
  const [labels, rules, hooks] = await Promise.all([
    safe(() => api.listLabels()),
    queueId ? safe(() => api.listRules(queueId)) : Promise.resolve(null),
    queueId ? safe(() => api.listHooks(queueId)) : Promise.resolve(null),
  ]);
  const labelsById = {};
  for (const l of labels || []) labelsById[String(l.id)] = { id: String(l.id), name: l.name, color: l.color, url: l.url };
  const labelRules = extractLabelRules(rules || []);
  const hooksById = {};
  for (const hk of (hooks || [])) hooksById[hk.id] = hk;
  const cur = store.data.value;
  if (!cur || myId !== loadId) return; // superseded → don't merge stale label context into another annotation
  store.data.value = { ...cur, resolved: { ...cur.resolved, labelsById, labelRules, hooksById: { ...cur.resolved.hooksById, ...hooksById }, _hooksLoaded: true } };
}

// For the orchestrator's programmatic correlation (rule → field): populate
// resolved.rules from the queue's rules.
export async function loadQueueRules() {
  const d = store.data.value;
  if (!d || !d.annotation.queue || d.resolved._rulesLoaded) return;
  const myId = loadId;
  const rules = await safe(() => api.listRules(idFromUrl(d.annotation.queue))) || [];
  const cur = store.data.value; if (!cur || myId !== loadId) return; // superseded → skip stale write
  store.data.value = { ...cur, resolved: { ...cur.resolved, rules, _rulesLoaded: true } };
}

// Intake context: parent document, duplicate relations, source email — all best-effort.
export async function loadIntakeContext() {
  const d = store.data.value;
  if (!d || d.resolved._intakeLoaded) return;
  const myId = loadId;
  const doc = d.resolved.document || null;
  const [parentDocument, relations, email] = await Promise.all([
    doc?.parent ? safe(() => api.getDocument(doc.parent)) : Promise.resolve(null),
    Promise.all((d.annotation.relations || []).map((u) => safe(() => api.getRelation(u)))).then((rs) => rs.filter(Boolean)),
    (d.annotation.email || doc?.email) ? safe(() => api.getEmail(d.annotation.email || doc.email)) : Promise.resolve(null),
  ]);
  const cur = store.data.value;
  if (!cur || myId !== loadId) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, parentDocument, relations, email, _intakeLoaded: true } };
}

// Approval-workflow context: runs + their steps.
export async function loadWorkflowContext() {
  const d = store.data.value;
  if (!d || d.resolved._workflowLoaded) return;
  const myId = loadId;
  const runs = await safe(() => api.listWorkflowRuns(d.annotation.id)) || [];
  const wfIds = [...new Set(runs.map((r) => idFromUrl(r.workflow)).filter(Boolean))];
  const steps = (await Promise.all(wfIds.map((id) => safe(() => api.listWorkflowSteps(id))))).flat().filter(Boolean);
  const cur = store.data.value;
  if (!cur || myId !== loadId) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, workflowRuns: runs, workflowSteps: steps, _workflowLoaded: true } };
}

// Rebuild the evidence model from current signals — cheap and pure; call after
// every source load and after attribution changes.
export function recomputeEvidence() {
  const d = store.data.value;
  if (!d) { store.evidence.value = null; return; }
  store.evidence.value = buildEvidence({
    annotation: d.annotation, blocker: d.blocker, content: d.content,
    queue: d.resolved.queue, schema: d.resolved.schema, document: d.resolved.document,
    parentDocument: d.resolved.parentDocument || null, relations: d.resolved.relations || [],
    email: d.resolved.email || null, enrichment: store.enrichment.value,
    resolved: d.resolved, workflowRuns: d.resolved.workflowRuns || [],
    workflowSteps: d.resolved.workflowSteps || [], attributions: store.attributions.value,
    live: store.live.value,
  });
}

// Back to the landing view (recents list): tear down the current investigation —
// bump loadId so in-flight loaders no-op, abort streams, clear the annotation.
export function closeAnnotation() {
  loadId++;
  if (attrController) attrController.abort();
  store.setAnnotationId(null);
  loadRecents().then(() => enrichRecents(api)).catch(() => {}); // refresh the viewed list on return
}

// Follow-up question to Mr. Fabry in the finished synthesis chat. Appends a
// followup entry {q, text, status} to store.synthesis and streams the answer in.
export async function askFabry(question) {
  const syn = store.synthesis.value;
  const q = String(question || '').trim();
  if (!q || !syn || syn.status !== 'done' || !syn.chatId) return;
  if ((syn.followups || []).some((f) => f.status === 'streaming')) return; // one at a time
  // Tracked below every guard: above them a refused click counted as a
  // follow-up that ran (same rule as architect/actions.js and fabry/chat.js).
  track('sa_inspector_followup');
  const myId = loadId;
  const signal = attrController ? attrController.signal : undefined;
  const patch = (fn) => {
    if (myId !== loadId) return;
    const cur = store.synthesis.value;
    if (!cur || !cur.followups) return;
    const followups = [...cur.followups];
    fn(followups);
    store.synthesis.value = { ...cur, followups };
  };
  patch((f) => f.push({ q, text: '', status: 'streaming' }));
  try {
    const res = await continueSynthesis({
      agentApi, chatId: syn.chatId, question: q, signal,
      onPhase: (p) => { if (myId === loadId) store.setInvestigation({ activity: p }); },
      onText: (t) => patch((f) => { f[f.length - 1] = { ...f[f.length - 1], text: t }; }),
    });
    patch((f) => { f[f.length - 1] = { q, text: res.text, status: 'done' }; });
  } catch (e) {
    if (e?.name === 'AbortError') return;
    patch((f) => { f[f.length - 1] = { ...f[f.length - 1], status: 'error' }; });
  } finally {
    if (myId === loadId) store.setInvestigation({ activity: '' });
  }
}

// Opt-in live re-evaluate (the only write path). If run before synthesis starts, the
// recomputed evidence (drift:*) joins what the narrative can cite; running it later
// does NOT trigger a re-synthesis (spec §4.5) — the diff renders in its section only.
export async function runRevalidate() {
  track('sa_inspector_revalidate');
  const id = store.annotationId.value;
  const res = await api.revalidate(id);
  store.live.value = { messages: res?.messages || [], matchedTriggerRules: res?.matched_trigger_rules || [] };
  recomputeEvidence();
}
