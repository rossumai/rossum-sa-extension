let baseDomain = '';
let authHeader = '';

export function init(domain, token) {
  baseDomain = domain;
  authHeader = `Bearer ${token}`;
}

const REQUEST_TIMEOUT = 30_000;

function combinedSignal(externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
    } else {
      externalSignal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    }
  }
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  return { signal, timer, externalSignal };
}

async function get(path, { signal: externalSignal } = {}) {
  const { signal, timer, externalSignal: ext } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(`${baseDomain}${path}`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (ext?.aborted) throw err;
      throw apiError('Request timed out after 30s', 0);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError('Session expired. Open a Rossum page and click Audit Logs again to reconnect.', 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = formatApiError(data, res.status);
    const err = apiError(message, res.status);
    err.fieldErrors = extractFieldErrors(data);
    // 403/404 on the audit-log endpoint typically means the feature is
    // unavailable for this tenant — either the caller lacks the required
    // role or the feature isn't included in the organization's subscription.
    // We surface this as a dedicated "unavailable" state instead of a
    // transient error banner.
    if (res.status === 403 || res.status === 404) {
      err.featureUnavailable = true;
    }
    throw err;
  }
  return data;
}

function apiError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// DRF-style validation responses are { field: [msg, ...] } per offending
// field. Also handles { detail } / { message } and the array-of-errors form.
function formatApiError(data, status) {
  if (data?.detail) return String(data.detail);
  if (data?.message) return String(data.message);
  const fieldErrs = extractFieldErrors(data);
  const parts = Object.entries(fieldErrs).map(([f, msgs]) => `${f}: ${msgs.join('; ')}`);
  if (parts.length) return parts.join(' — ');
  return `API error ${status}`;
}

function extractFieldErrors(data) {
  const out = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [field, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.every((m) => typeof m === 'string')) {
      out[field] = val;
    }
  }
  return out;
}

function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

export function listAuditLogs({
  page = 1,
  pageSize = 50,
  object_type,
  action,
  signal,
} = {}) {
  const qs = buildQuery({
    page,
    page_size: pageSize,
    object_type,
    action,
  });
  return get(`/api/v1/audit_logs/?${qs}`, { signal });
}

export function whoami({ signal } = {}) {
  return get('/api/v1/auth/user/', { signal });
}
