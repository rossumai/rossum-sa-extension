// Impure glue for Architect (v2): binds the store to Data Storage (api.js) and
// the agent transport. Run creates one fresh cautious read-only chat per
// deliverable, then persists the result onto its own doc. Mirrors chat.js.
import * as agentApi from '../../agent/agentApi.js';
import { newAcc, foldEvents, replyText } from '../../agent/agentStream.js';
import * as api from './api.js';
import * as check from './check.js';
import { runChecks } from './run.js';
import * as store from './store.js';
import { EXAMPLE_DELIVERABLE } from './example.js';
import * as refine from './refine.js';
import { formatAnswers } from '../chat.js';

let controller = null;
let runId = 0;
let loading = false;

function newId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return 'r' + Date.now() + Math.random().toString(36).slice(2, 8);
}
function clearSpinners() {
  const cleaned = {};
  for (const [k, v] of Object.entries(store.results.value)) cleaned[k] = v?.running ? { ...v, running: false } : v;
  store.results.value = cleaned;
}

export async function loadArchitect() {
  if (store.loaded.value || loading) return;
  loading = true;
  store.loadError.value = null;
  try {
    await api.ensureCollection();
    const { deliverables, results } = await api.loadDeliverables();
    store.deliverables.value = deliverables;
    store.results.value = results;
    // First open (no active selection) OR a restored id that no longer exists
    // (deleted elsewhere): land on the first deliverable, not the placeholder.
    if (deliverables.length && !deliverables.some((d) => d.id === store.activeId.value)) {
      store.activeId.value = deliverables[0].id;
    }
    store.loaded.value = true;
  } catch (err) {
    store.loadError.value = err?.message || 'Could not load deliverables.';
  } finally {
    loading = false;
  }
}

export async function addDeliverable(text = '') {
  // Seed the very FIRST deliverable with a self-describing demo (so a new user
  // sees how Architect works); once any deliverable exists, new ones start blank.
  if (!text && store.deliverables.value.length === 0) text = EXAMPLE_DELIVERABLE;
  const order = store.deliverables.value.reduce((m, d) => Math.max(m, d.order || 0), 0) + 1;
  const d = { id: newId(), text: String(text || ''), order };
  store.deliverables.value = [...store.deliverables.value, d];
  store.activeId.value = d.id; // open the new one for editing
  try {
    await api.addDeliverable({ id: d.id, text: d.text, order, createdAt: Date.now() });
  } catch (err) {
    store.deliverables.value = store.deliverables.value.filter((x) => x.id !== d.id);
    if (store.activeId.value === d.id) store.activeId.value = null;
    store.loadError.value = err?.message || 'Could not create deliverable.';
  }
}

export function openDeliverable(id) { store.setActive(id); }

// Pure: move the item at fromIndex to toIndex (returns a new array).
export function reorder(arr, fromIndex, toIndex) {
  const a = arr.slice();
  const [moved] = a.splice(fromIndex, 1);
  a.splice(toIndex, 0, moved);
  return a;
}

// Drag-reorder: move deliverable `id` to `toIndex`, reassign sequential orders,
// and persist the docs whose order changed (non-fatal on error).
export async function moveDeliverable(id, toIndex) {
  const ds = store.deliverables.value;
  const fromIndex = ds.findIndex((d) => d.id === id);
  if (fromIndex < 0 || toIndex < 0 || toIndex >= ds.length || fromIndex === toIndex) return;
  const next = reorder(ds, fromIndex, toIndex).map((d, i) => ({ ...d, order: i }));
  store.deliverables.value = next;
  for (const d of next) {
    const prev = ds.find((x) => x.id === d.id);
    if (!prev || prev.order !== d.order) {
      try { await api.setOrder(d.id, d.order); } catch (err) { store.loadError.value = err?.message || 'Could not save order.'; }
    }
  }
}

export async function updateDeliverable(id, text) {
  const t = String(text ?? '');
  const prev = store.deliverables.value.find((d) => d.id === id);
  if (!prev || prev.text === t) return;
  store.deliverables.value = store.deliverables.value.map((d) => (d.id === id ? { ...d, text: t } : d));
  const r = store.results.value[id];
  if (r && !r.running && !r.stale) store.setResult(id, { ...r, stale: true });
  try {
    await api.updateDeliverable(id, t, Date.now());
  } catch (err) {
    store.loadError.value = err?.message || 'Could not save edit.';
  }
}

export async function deleteDeliverable(id) {
  store.deliverables.value = store.deliverables.value.filter((d) => d.id !== id);
  const rest = { ...store.results.value };
  delete rest[id];
  store.results.value = rest;
  if (store.activeId.value === id) store.activeId.value = null;
  try {
    await api.deleteDeliverable(id);
  } catch (err) {
    store.loadError.value = err?.message || 'Could not delete deliverable.';
  }
}

// Fold one refine turn's stream into an accumulator (reasoning/text/questions).
async function foldRefine(id, content, signal) {
  const acc = newAcc();
  await agentApi.streamMessage(id, content, { signal, onEvent: (e) => foldEvents(acc, [e]) });
  return acc;
}

// Interpret a folded turn: the agent may ask clarifying questions (interactive
// elements) INSTEAD of revising — surface those so the caller can answer; otherwise
// return the revised Markdown proposal (possibly empty — the caller guards Accept).
function refineResult(id, acc) {
  if (acc.questions) return { chatId: id, questions: acc.questions };
  return { chatId: id, proposal: refine.parseRefinedText(replyText(acc)) };
}

// One turn of the ITERATIVE "Refine wording" flow. First turn (no chatId) opens a
// fresh cautious, read-only chat and applies the first instruction; later turns reuse
// the chat so Fabry builds on its last proposal (chat memory). Returns
// { chatId, proposal } OR { chatId, questions } (agent asked), or null if the caller
// aborted. The caller (RefineDock) owns the AbortController; nothing is written here.
export async function refineTurn({ chatId, deliverableText, instruction, signal }) {
  try {
    let id = chatId;
    if (!id) {
      id = await agentApi.createChat();
      if (signal?.aborted) return null;
      await foldRefine(id, '/persona cautious', signal);
      if (signal?.aborted) return null;
      const acc = await foldRefine(id, refine.buildRefineFirst(deliverableText, instruction), signal);
      if (signal?.aborted) return null;
      return refineResult(id, acc);
    }
    const acc = await foldRefine(id, refine.buildRefineNext(instruction), signal);
    if (signal?.aborted) return null;
    return refineResult(id, acc);
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return null;
    throw err;
  }
}

// Answer the agent's clarifying questions (interactive elements) as the next message
// in the SAME refine chat — a plain message IS the answer. Returns the same shape as
// refineTurn (a proposal, or a further round of questions), or null if aborted.
export async function answerRefine({ chatId, answers, signal }) {
  try {
    const acc = await foldRefine(chatId, formatAnswers(answers), signal);
    if (signal?.aborted) return null;
    return refineResult(chatId, acc);
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return null;
    throw err;
  }
}

async function runOne(d, signal) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return null;
  const fold = async (content) => {
    const acc = newAcc();
    await agentApi.streamMessage(chatId, content, { signal, onEvent: (e) => foldEvents(acc, [e]) });
    return replyText(acc);
  };
  await fold('/persona cautious');
  if (signal?.aborted) return null;
  const text = await fold(check.buildCheckPrompt(d.text));
  if (signal?.aborted) return null;
  const { verdict, evidence } = check.parseCheckVerdict(text);
  return { verdict, evidence, chatId };
}

// Record + persist a completed result onto its own doc (write to OUR system
// collection; non-fatal on error — the result stays in memory).
function persist(id, r) {
  if (r.error) {
    // Transient transport error (e.g. 429/network): surface it this session but
    // do NOT clobber the doc's last-known-good result (the remembered verdict must
    // survive a rate-limited run — matches reRun's memory-only error handling).
    store.setResult(id, { ...r, running: false });
    return;
  }
  const ranAt = Date.now();
  store.setResult(id, { ...r, ranAt, stale: false, running: false });
  api.saveResult(id, { verdict: r.verdict, evidence: r.evidence, chatId: r.chatId, ranAt }).catch(() => {});
}

export async function runAll() {
  if (store.running.value) return;
  if (Object.values(store.results.value).some((r) => r && r.running)) return;
  const ds = store.deliverables.value;
  if (!ds.length) return;
  runId += 1;
  const id = runId;
  controller = new AbortController();
  const signal = controller.signal;
  store.running.value = true;
  const pending = { ...store.results.value };
  for (const d of ds) pending[d.id] = { ...(pending[d.id] || { verdict: null, evidence: '', chatId: null }), running: true };
  store.results.value = pending;
  try {
    await runChecks(ds, {
      concurrency: 3,
      signal,
      runOne: (d) => runOne(d, signal),
      onResult: (rid, result) => { if (id === runId) persist(rid, result); },
    });
  } finally {
    if (id === runId) { clearSpinners(); store.running.value = false; controller = null; }
  }
}

export async function reRun(id) {
  const d = store.deliverables.value.find((x) => x.id === id);
  if (!d) return;
  const ctrl = new AbortController();
  store.setResult(id, { ...(store.results.value[id] || { verdict: null, evidence: '', chatId: null }), running: true });
  try {
    const result = await runOne(d, ctrl.signal);
    if (result) persist(id, result);
    else store.setResult(id, { ...(store.results.value[id] || {}), running: false });
  } catch (err) {
    store.setResult(id, { verdict: 'uncertain', evidence: `Check could not complete: ${err?.message || err}`, chatId: null, ranAt: Date.now(), stale: false, error: true });
  }
}

export function stopRun() {
  runId += 1;
  if (controller) controller.abort();
  controller = null;
  store.running.value = false;
  clearSpinners();
}
