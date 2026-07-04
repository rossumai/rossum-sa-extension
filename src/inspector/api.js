// REST client for the Annotation Inspector. Read-only by default; the only
// write is revalidate() (start -> content/validate -> cancel), gated behind an
// explicit "Re-evaluate" user action. Mirrors src/galaxy/api.js.

let baseDomain = '';
let authHeader = '';
const REQUEST_TIMEOUT = 30_000;

export function init(domain, token) {
  baseDomain = domain;
  authHeader = `Bearer ${token}`;
}

function toUrl(p) { return /^https?:\/\//.test(p) ? p : `${baseDomain}${p}`; }
function apiError(message, status) { const e = new Error(message); e.status = status; return e; }

function combinedSignal(externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  if (externalSignal) {
    if (externalSignal.aborted) clearTimeout(timer);
    else externalSignal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  return { signal, timer, externalSignal };
}

export async function get(pathOrUrl, { signal: externalSignal } = {}) {
  const { signal, timer, externalSignal: ext } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(toUrl(pathOrUrl), { headers: { Authorization: authHeader, Accept: 'application/json' }, signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') { if (ext?.aborted) throw err; throw apiError('Request timed out after 30s', 0); }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) throw apiError('Session expired. Open a Rossum page and click Inspector again to reconnect.', 401);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = apiError(data?.detail || data?.message || `API error ${res.status}`, res.status);
    if (res.status === 403) err.featureUnavailable = true;
    throw err;
  }
  return data;
}

export function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v == null || v === '') continue; sp.set(k, String(v)); }
  return sp.toString();
}

export async function listAll(pathOrUrl, { signal } = {}) {
  const out = [];
  let next = pathOrUrl;
  while (next) {
    const page = await get(next, { signal });
    if (Array.isArray(page?.results)) out.push(...page.results);
    next = page?.pagination?.next || null;
  }
  return out;
}

export async function safeListAll(pathOrUrl, opts) {
  try { return await listAll(pathOrUrl, opts); }
  catch (err) { if (err.status === 403 || err.status === 404) return []; throw err; }
}

export function whoami({ signal } = {}) { return get('/api/v1/auth/user/', { signal }); }

// ---- forensics: core (GET) ----
export const getAnnotation = (id, o) => get(`/api/v1/annotations/${id}`, o);
export const getAutomationBlocker = (url, o) => get(url, o); // url from annotation.automation_blocker
export const getContent = (id, o) => get(`/api/v1/annotations/${id}/content`, o);
export const getQueue = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/queues/${idOrUrl}`, o);
export const getSchema = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/schemas/${idOrUrl}`, o);
export const getDocument = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/documents/${idOrUrl}`, o);
export const getHook = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/hooks/${idOrUrl}`, o);
export const getRule = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/rules/${idOrUrl}`, o);
export const getUser = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/users/${idOrUrl}`, o);

// ---- forensics: enrichment (best-effort; 403/404 -> []) ----
export const listNotes = (annId, o) => safeListAll(`/api/v1/notes?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listWorkflowActivities = (annId, o) => safeListAll(`/api/v1/workflow_activities?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listAuditLogs = (annId, o) => safeListAll(`/api/v1/audit_logs?${buildQuery({ object_type: 'annotation', object_id: annId, page_size: 100 })}`, o);
// Hook logs live at /hooks/logs (NOT /hook_logs, which 404s). Only annotation/hook/queue filter.
export const listHookLogs = (annId, o) => safeListAll(`/api/v1/hooks/logs?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listRuleExecutionLogs = (annId, o) => safeListAll(`/api/v1/rules_execution_logs?${buildQuery({ annotation_id: annId, page_size: 100 })}`, o);
export const listWorkflowRuns = (annId, o) => safeListAll(`/api/v1/workflow_runs?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listWorkflowSteps = (workflowId, o) => safeListAll(`/api/v1/workflow_steps?${buildQuery({ workflow: workflowId, page_size: 100 })}`, o);
export const getRelation = (url, o) => get(url, o);   // url from annotation.relations[]
export const getEmail = (url, o) => get(url, o);      // url from annotation.email / document.email
// Resolve several annotations + their documents/queues in ONE call (verified
// live 2026-07-04: ?id=<csv> filters, sideload attaches; unknown ids dropped).
export const listAnnotationsByIds = (ids, o) => get(`/api/v1/annotations?${buildQuery({ id: (ids || []).join(','), sideload: 'documents,queues', page_size: Math.max(1, (ids || []).length) })}`, o);

// Page resources list — one call for all pages (verified live 2026-07-04).
export const listPages = (annId, o) => safeListAll(`/api/v1/pages?${buildQuery({ annotation: annId, page_size: 100 })}`, o);

// Binary fetch for page images: the page `content` URL 401s without the Bearer
// header (verified live), so a plain <img src> can't load it — fetch → Blob.
export async function getBlob(pathOrUrl, { signal: externalSignal } = {}) {
  const { signal, timer, externalSignal: ext } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(toUrl(pathOrUrl), { headers: { Authorization: authHeader }, signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') { if (ext?.aborted) throw err; throw apiError('Request timed out after 30s', 0); }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) throw apiError('Session expired.', 401);
  if (!res.ok) throw apiError(`API error ${res.status}`, res.status);
  return res.blob();
}
export const listHooks = (queueId, o) => safeListAll(`/api/v1/hooks?${buildQuery({ queue: queueId, page_size: 100 })}`, o);
export const listLabels = (o) => safeListAll(`/api/v1/labels?${buildQuery({ page_size: 100 })}`, o);
export const listRules = (queueId, o) => safeListAll(`/api/v1/rules?${buildQuery({ queue: queueId, page_size: 100 })}`, o);

// ---- live re-evaluate (the only write; start -> validate -> cancel-in-finally) ----
async function post(path, body, { signal } = {}) {
  const { signal: s, timer } = combinedSignal(signal);
  let res;
  try {
    res = await fetch(toUrl(path), {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
      signal: s,
    });
  } finally { clearTimeout(timer); }
  if (res.status === 401) throw apiError('Session expired.', 401);
  if (!res.ok && res.status !== 204) { const d = await res.json().catch(() => null); throw apiError(d?.detail || `API error ${res.status}`, res.status); }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function revalidate(id, { signal } = {}) {
  await post(`/api/v1/annotations/${id}/start`, {}, { signal });
  try {
    return await post(`/api/v1/annotations/${id}/content/validate`, {}, { signal });
  } finally {
    await post(`/api/v1/annotations/${id}/cancel`, {}, { signal }).catch(() => {}); // tolerate 409
  }
}
