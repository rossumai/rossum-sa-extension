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
import * as title from './title.js';
import { formatAnswers } from '../chat.js';
import { summaryLine } from './format.js';
import * as plan from './plan.js';
import { runImplement } from './implementLoop.js';
import * as audit from './audit.js';

let controller = null;
let runId = 0;
let loading = false;

function newId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return 'r' + Date.now() + Math.random().toString(36).slice(2, 8);
}
// Flip every dangling `running` flag off in a { [id]: entry } signal (both the
// check results and the implement state share this shape).
function clearRunningFlags(sig) {
  const cleaned = {};
  for (const [k, v] of Object.entries(sig.value)) cleaned[k] = v?.running ? { ...v, running: false } : v;
  sig.value = cleaned;
}
function clearSpinners() { clearRunningFlags(store.results); }
function clearImplementSpinners() { clearRunningFlags(store.implement); }

export async function loadArchitect() {
  if (store.loaded.value || loading) return;
  loading = true;
  store.loadError.value = null;
  try {
    await api.ensureCollection();
    const { deliverables, results, implement } = await api.loadDeliverables();
    store.deliverables.value = deliverables;
    store.results.value = results;
    // Rehydrate persisted implement-loop state (status / task list / write audit)
    // so a completed Implement run survives a reload instead of vanishing. See
    // finding actions.js:44.
    store.implement.value = implement || {};
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
  // Backfill AI titles for any untitled deliverables — fire-and-forget so a
  // slow/offline agent never blocks load; failures stay silent (derived
  // fallback title is already showing).
  if (store.loaded.value) backfillTitles().catch(() => {});
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
    generateTitle(id); // fire-and-forget; self-guards (existing title / short text / in-flight)
  } catch (err) {
    store.loadError.value = err?.message || 'Could not save edit.';
  }
}

const titleInFlight = new Set();

// Manual rename (persists the explicit title).
export async function renameDeliverable(id, newTitle) {
  const clean = String(newTitle ?? '').trim();
  store.deliverables.value = store.deliverables.value.map((d) => (d.id === id ? { ...d, title: clean } : d));
  try { await api.saveTitle(id, clean); }
  catch (err) { store.loadError.value = err?.message || 'Could not save title.'; }
}

// Read-only AI title generation — only when the deliverable has meaningful text and
// no title yet. Offline/error → silently keep the derived fallback. Guarded against
// duplicate in-flight calls.
export async function generateTitle(id) {
  const d = store.deliverables.value.find((x) => x.id === id);
  if (!d || (d.title && d.title.trim()) || d.text.trim().length < 8 || titleInFlight.has(id)) return;
  titleInFlight.add(id);
  try {
    const chatId = await agentApi.createChat();
    const acc = newAcc();
    await agentApi.streamMessage(chatId, title.buildTitlePrompt(d.text), { onEvent: (e) => foldEvents(acc, [e]) });
    const t = title.parseTitle(replyText(acc));
    if (t && !store.deliverables.value.find((x) => x.id === id)?.title) await renameDeliverable(id, t);
  } catch { /* offline / error → keep the derived fallback */ }
  finally { titleInFlight.delete(id); }
}

// Backfill titles for all untitled-with-text deliverables (bounded concurrency 3).
export async function backfillTitles() {
  const q = store.deliverables.value.filter((d) => !(d.title && d.title.trim()) && d.text.trim().length >= 8).map((d) => d.id);
  const worker = async () => { while (q.length) await generateTitle(q.shift()); };
  await Promise.all([worker(), worker(), worker()]);
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
  // A read-only check and the write-enabled implement loop both persist the
  // deliverable's Check verdict; running them at once lets a stale pre-change
  // verdict clobber the post-implementation one. Keep them mutually exclusive.
  if (store.implementRunning.value) return;
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
  // Never run a check on a deliverable that an implement run is actively driving —
  // its roll-up owns the verdict (see runAll). UI gating backs this up.
  if (store.implementRunning.value) return;
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

// ── Implement loop (ralph-style, write-enabled) ─────────────────────────────
let implController = null;
let implRunId = 0;

// READ-ONLY planning turn (DEFAULT persona — the model plans best autonomously; no writes).
async function planOne(d, signal) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return null;
  const acc = newAcc();
  await agentApi.streamMessage(chatId, plan.buildPlanPrompt(d.text), { signal, onEvent: (e) => foldEvents(acc, [e]) });
  if (signal?.aborted) return null;
  return plan.parsePlan(replyText(acc));
}

// WRITE task turn — the ONLY write call site (mcpMode:'read-write'), DEFAULT persona, NO priming.
async function implementTaskOne(d, task, { attempt, journal, doneTasks }, signal) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return null;
  const acc = newAcc();
  const folder = audit.makeAuditFolder();
  try {
    await agentApi.streamMessage(chatId, plan.buildTaskPrompt(d.text, task, { journal, doneTasks }), {
      signal, mcpMode: 'read-write', onEvent: (e) => { foldEvents(acc, [e]); folder.feed(e); },
    });
  } catch (err) {
    // The stream threw (Stop / idle timeout / transport error) AFTER the agent may
    // have already executed writes against the live org. Attach what was audited so
    // the loop still counts + records them — losing them would defeat the write
    // audit and under-count the write budget. See finding actions.js:322.
    if (err && typeof err === 'object') err.writes = folder.writes;
    throw err;
  }
  // NB: do NOT early-return null on a late `signal.aborted` here. The stream already
  // RESOLVED, so any writes in the audit folder really happened; returning them lets
  // the loop count + record them before it honors the abort (its own post-write abort
  // check stops the run). Discarding them here would silently lose audited prod writes.
  const text = replyText(acc);
  return { writes: folder.writes, summary: summaryLine(text) || '(no summary)', discovered: plan.parseDiscovered(text), chatId };
}

// READ-ONLY per-task check (fresh cautious chat).
async function checkTaskOne(d, task, signal) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return null;
  const fold = async (content) => { const acc = newAcc(); await agentApi.streamMessage(chatId, content, { signal, onEvent: (e) => foldEvents(acc, [e]) }); return replyText(acc); };
  await fold('/persona cautious');
  if (signal?.aborted) return null;
  const text = await fold(plan.buildTaskCheckPrompt(task.text, task.acceptance));
  if (signal?.aborted) return null;
  return check.parseCheckVerdict(text);
}

// Apply a loop patch to the store; reflect a check verdict in the shared banner;
// persist on `done`.
function applyImplementPatch(id, patch) {
  const cur = store.implement.value[id] || {};
  const next = { ...cur, ...patch, stale: false };
  if (patch.writes) next.writes = [...(cur.writes || []), ...patch.writes];
  if (patch.tasks) next.tasks = patch.tasks; // full replace each time — never concatenated
  if (patch.journal) next.journal = patch.journal; // full replace (loop sends the accumulated journal)
  if (patch.note) { next.notes = [...(cur.notes || []), patch.note]; delete next.note; }
  store.implement.value = { ...store.implement.value, [id]: next };
  if (patch.verdict) {
    const v = patch.verdict;
    const ranAt = Date.now();
    store.setResult(id, { verdict: v.verdict, evidence: v.evidence, chatId: v.chatId, ranAt, stale: false, running: false });
    // Persist the roll-up as the deliverable's Check result so the post-implementation
    // verdict survives reload (mirrors the standalone check's persist()). Disjoint $set
    // from the implement fields, so it never clobbers saveImplementResult. A transport-
    // errored roll-up is shown but NOT persisted — preserve last-known-good, like persist().
    if (!patch.verdictErrored) api.saveResult(id, { verdict: v.verdict, evidence: v.evidence, chatId: v.chatId, ranAt }).catch(() => {});
  }
  if (patch.done) {
    const ranAt = Date.now();
    const tasks = next.tasks || [];
    api.saveImplementResult(id, {
      status: next.status, attempts: tasks.reduce((s, t) => s + (t.attempts || 0), 0), writes: next.writes || [],
      summary: next.summary || '', chatId: next.chatId || (store.results.value[id]?.chatId) || null,
      ranAt, journal: next.journal || [], tasks,
    }).catch(() => {});
  }
}

async function runImplementList(ds) {
  if (store.implementRunning.value || !ds.length) return;
  // Don't start writing while ANY read-only check is in flight — a global Run all
  // (store.running) OR a single per-deliverable Re-run (results[id].running, which does
  // NOT set store.running). Otherwise that check's late persist(verdict) can clobber the
  // implement roll-up's persisted verdict. See finding actions.js:397.
  if (store.running.value || Object.values(store.results.value).some((r) => r && r.running)) return;
  implRunId += 1; const rid = implRunId;
  const ctrl = new AbortController(); implController = ctrl;
  store.implementRunning.value = true;
  // Reset the FULL prior-run state (tasks/notes/summary/journal too — not just
  // writes/status), so a re-implement whose planning turn fails can't leave the
  // previous run's task list + notes showing under a fresh status. See finding
  // actions.js:377.
  for (const d of ds) store.setImplement(d.id, { status: 'running', running: true, writes: [], tasks: [], notes: [], summary: '', journal: [], error: null });
  try {
    await runImplement(ds, {
      maxAttemptsPerTask: 5, maxPlanTasks: 12, maxTotalTasks: 20, maxTotalWrites: 50, maxRollupRounds: 3,
      signal: ctrl.signal,
      planOne: (dd) => planOne(dd, ctrl.signal),
      implementTaskOne: (dd, task, cx) => implementTaskOne(dd, task, cx, ctrl.signal),
      checkTaskOne: (dd, task) => checkTaskOne(dd, task, ctrl.signal),
      checkDeliverable: (dd) => runOne(dd, ctrl.signal),
      onEvent: (eid, patch) => { if (rid === implRunId) applyImplementPatch(eid, patch); },
    });
  } finally { if (rid === implRunId) { clearImplementSpinners(); store.implementRunning.value = false; implController = null; } }
}

export function reImplement(id) {
  const d = store.deliverables.value.find((x) => x.id === id);
  return d ? runImplementList([d]) : undefined;
}

export function stopImplement() {
  // Do NOT bump implRunId here. The aborting loop emits ONE terminal `stopped`
  // patch as it unwinds; keeping the run id lets that patch through the onEvent
  // guard so the deliverable's status is reset to 'stopped' and its write audit is
  // PERSISTED (findings actions.js:361 / actions.js:396). A NEW run bumps the id
  // itself (runImplementList), which supersedes any late patch from this one.
  if (implController) implController.abort();
  implController = null;
  store.implementRunning.value = false;
  clearImplementSpinners();
}
