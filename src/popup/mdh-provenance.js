// MDH provenance — pure cascade replay engine + parsing helpers.
// No DOM access; consumers (Preact components) render based on returned data.

// ── API ─────────────────────────────────────────────

export async function fetchJson(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function runAggregate(domain, token, dataset, pipeline, externalSignal, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const resp = await fetch(`${domain}/svc/data-storage/api/v1/data/aggregate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ collectionName: dataset, pipeline }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.clone().json();
        detail = body?.message || body?.detail || body?.error || '';
      } catch {
        try { detail = await resp.text(); } catch { /* ignore */ }
      }
      detail = (detail || '').toString().trim();
      throw new Error(detail ? `${resp.status}: ${detail}` : `${resp.status}`);
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export function extractIdFromUrl(url) {
  if (!url) return null;
  const path = String(url).split(/[?#]/, 1)[0];
  const m = path.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

// ── Hook config parsing ────────────────────────────

function describeQuery(q) {
  const comment = q?.['//'];
  if (typeof comment === 'string' && comment.trim()) return comment.trim();
  if (q?.find && typeof q.find === 'object') {
    const keys = Object.keys(q.find);
    return keys.length === 0 ? 'find: (empty)' : `find: ${keys.join(', ')}`;
  }
  const pipeline = q?.aggregate || q?.pipeline;
  if (Array.isArray(pipeline)) {
    const stages = pipeline.map((s) => Object.keys(s || {})[0]).filter(Boolean);
    return stages.length === 0 ? 'aggregate: (empty)' : `aggregate: ${stages.join(' → ')}`;
  }
  return '(unknown query type)';
}

// withLimit=true appends $limit:1 — used for replay (existence check).
// withLimit=false preserves the user's original query — used for clipboard copy.
export function queryToPipeline(q, { withLimit } = {}) {
  let pipeline = null;
  if (q?.find && typeof q.find === 'object') {
    pipeline = [{ $match: q.find }];
    if (q.sort) pipeline.push({ $sort: q.sort });
    if (q.skip) pipeline.push({ $skip: q.skip });
    if (!withLimit && q.limit) pipeline.push({ $limit: q.limit });
    if (!withLimit && q.projection) pipeline.push({ $project: q.projection });
  } else if (Array.isArray(q?.aggregate)) pipeline = [...q.aggregate];
  else if (Array.isArray(q?.pipeline)) pipeline = [...q.pipeline];
  if (pipeline && withLimit) pipeline.push({ $limit: 1 });
  return pipeline;
}

function extractConfigsFromHook(hook) {
  const out = [];
  const cfgs = hook?.settings?.configurations || [];
  for (const cfg of cfgs) {
    const target = cfg?.mapping?.target_schema_id || '';
    const dataset = cfg?.source?.dataset || '';
    const datasetKey = cfg?.mapping?.dataset_key || '';
    const queueIds = Array.isArray(cfg?.queue_ids) ? cfg.queue_ids : [];
    const queries = cfg?.source?.queries || cfg?.matching?.queries || [];
    out.push({
      name: cfg?.name || '',
      target: target || '(no target)',
      dataset: dataset || '(no dataset)',
      datasetKey,
      queueIds,
      queries: queries.map((q) => {
        const set = new Set();
        collectPlaceholders(q, set);
        // Array (not Set) so the structure survives chrome.storage.session JSON serialization.
        return { label: describeQuery(q), raw: q, placeholders: [...set] };
      }),
    });
  }
  return out;
}

function isMdhHook(hook) {
  if (!hook) return false;
  const cfgs = hook?.settings?.configurations;
  if (!Array.isArray(cfgs)) return false;
  return cfgs.some(
    (c) => Array.isArray(c?.source?.queries) || Array.isArray(c?.matching?.queries),
  );
}

// ── Placeholder substitution ───────────────────────

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export function collectPlaceholders(node, set) {
  if (node == null) return;
  if (typeof node === 'string') {
    for (const m of node.matchAll(PLACEHOLDER_RE)) set.add(m[1]);
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectPlaceholders(c, set);
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectPlaceholders(v, set);
  }
}

export function substitutePlaceholders(node, values) {
  if (node == null) return node;
  if (typeof node === 'string') {
    return node.replace(PLACEHOLDER_RE, (_, key) => {
      const v = values[key];
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((v) => substitutePlaceholders(v, values));
  if (typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[substitutePlaceholders(k, values)] = substitutePlaceholders(v, values);
    }
    return out;
  }
  return node;
}

function flattenContent(content) {
  const headerValues = {};
  const rowValues = {};
  let rowCount = 0;
  const walk = (node, rowIdx) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, rowIdx);
      return;
    }
    if (node.category === 'multivalue' && Array.isArray(node.children)) {
      const tuples = node.children.filter((c) => c?.category === 'tuple');
      if (tuples.length > rowCount) rowCount = tuples.length;
      tuples.forEach((tuple, idx) => walk(tuple, idx));
      return;
    }
    const sid = node.schema_id;
    const val = node?.content?.value;
    if (sid && (typeof val === 'string' || typeof val === 'number')) {
      if (rowIdx == null) {
        if (!(sid in headerValues)) headerValues[sid] = val;
      } else {
        if (!rowValues[sid]) rowValues[sid] = [];
        while (rowValues[sid].length <= rowIdx) rowValues[sid].push('');
        rowValues[sid][rowIdx] = val;
      }
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, rowIdx);
  };
  walk(content?.content || content, null);
  return { headerValues, rowValues, rowCount };
}

export function valuesForRow(headerValues, rowValues, rowIdx) {
  const out = { ...headerValues };
  for (const [sid, arr] of Object.entries(rowValues)) {
    out[sid] = arr[rowIdx] != null ? arr[rowIdx] : '';
  }
  return out;
}

export function configUsesLineItems(cfg, rowValues) {
  for (const q of cfg.queries) {
    for (const sid of q.placeholders) if (sid in rowValues) return true;
  }
  return false;
}

// Placeholders whose schema_id wasn't returned by the annotation content fetch.
// An empty-string value still counts as "present" — let the query run and surface
// MDH's actual response, since some operators (e.g. exact $match) accept empties.
function missingPlaceholders(placeholders, values) {
  const missing = [];
  for (const key of placeholders) {
    if (!(key in values)) missing.push(key);
  }
  return missing;
}

// ── Queue → MDH hooks resolver ─────────────────────

export async function loadMdhHooksForQueue(domain, token, queueId) {
  const hooksResp = await fetchJson(
    `${domain}/api/v1/hooks?queue=${queueId}&page_size=100`,
    token,
  );
  const candidates = (hooksResp?.results || []).filter(
    (h) => h.active !== false && h.type === 'webhook',
  );
  if (candidates.length === 0) return [];
  const details = await Promise.all(
    candidates.map((h) =>
      fetchJson(`${domain}/api/v1/hooks/${h.id}`, token).catch(() => null),
    ),
  );
  return details.filter(isMdhHook);
}

export function buildHookEntries(mdhHooks, queueId) {
  const queueIdNum = Number(queueId);
  return mdhHooks
    .map((hook) => ({
      hook,
      cfgs: extractConfigsFromHook(hook).filter(
        (c) => c.queueIds.length === 0 || c.queueIds.includes(queueIdNum),
      ),
    }))
    .filter((e) => e.cfgs.length > 0);
}

export async function loadAnnotationValues(domain, token, annotationId, placeholders) {
  if (!annotationId || placeholders.size === 0) {
    return { headerValues: {}, rowValues: {}, rowCount: 0 };
  }
  const url = `${domain}/api/v1/annotations/${annotationId}/content?schema_id=${[...placeholders].join(',')}`;
  const cdata = await fetchJson(url, token);
  return flattenContent(cdata);
}

// ── Status metadata (consumed by QueryItem renderer) ──

export const STATUS_GLYPH = {
  pending: { glyph: '…', cls: 'mdh-q-status--pending', title: 'Replaying…', showHint: false },
  winner: { glyph: '✓', cls: 'mdh-q-status--winner', title: 'Winning query', showHint: false },
  empty: { glyph: '—', cls: 'mdh-q-status--empty', title: 'No results', showHint: false },
  skipped: { glyph: '·', cls: 'mdh-q-status--skipped', title: 'Cascade short-circuited before this query', showHint: true },
  error: { glyph: '!', cls: 'mdh-q-status--error', title: 'Replay failed', showHint: true },
};

// ── Cascade replay ─────────────────────────────────

// Runs the cascade: for each query, evaluate against MDH (with $limit:1) until
// one matches. Subsequent queries get marked "skipped". Returns the full
// statuses array (suitable for caching). `onStatus(i, {status, hint})` fires
// as each query resolves, so callers can update UI incrementally.
export async function replayConfig(domain, token, cfg, values, signal, onStatus) {
  const statuses = new Array(cfg.queries.length).fill(null);
  const record = (i, status, hint) => {
    statuses[i] = hint == null ? { status } : { status, hint };
    onStatus?.(i, statuses[i]);
  };
  let foundWinner = false;
  for (let i = 0; i < cfg.queries.length; i++) {
    if (signal?.aborted) return null;
    if (foundWinner) {
      record(i, 'skipped', 'an earlier query already matched');
      continue;
    }
    const query = cfg.queries[i];
    const missing = missingPlaceholders(query.placeholders, values);
    if (missing.length > 0) {
      record(i, 'skipped', `missing field${missing.length === 1 ? '' : 's'} in annotation: ${missing.join(', ')}`);
      continue;
    }
    const pipeline = queryToPipeline(query.raw, { withLimit: true });
    if (!pipeline) {
      record(i, 'error', 'unknown query type');
      continue;
    }
    const substituted = substitutePlaceholders(pipeline, values);
    try {
      const data = await runAggregate(domain, token, cfg.dataset, substituted, signal);
      if (signal?.aborted) return null;
      const hits = Array.isArray(data?.result) ? data.result.length : 0;
      if (hits > 0) {
        record(i, 'winner', `${hits} hit${hits === 1 ? '' : 's'}`);
        foundWinner = true;
      } else {
        record(i, 'empty');
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      record(i, 'error', e?.message || 'request failed');
    }
  }
  return statuses;
}
