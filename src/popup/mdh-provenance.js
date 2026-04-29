// MDH provenance — cascade replay engine + DOM render helpers consumed by popup.js.

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
function queryToPipeline(q, { withLimit } = {}) {
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
      queries: queries.map((q) => ({ label: describeQuery(q), raw: q })),
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

export function collectPlaceholders(node, set) {
  if (node == null) return;
  if (typeof node === 'string') {
    const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    let m;
    while ((m = re.exec(node)) !== null) set.add(m[1]);
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
    return node.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key) => {
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
  const used = new Set();
  for (const q of cfg.queries) collectPlaceholders(q.raw, used);
  for (const sid of used) if (sid in rowValues) return true;
  return false;
}

// Placeholders whose schema_id wasn't returned by the annotation content fetch.
// An empty-string value still counts as "present" — let the query run and surface
// MDH's actual response, since some operators (e.g. exact $match) accept empties.
function missingPlaceholdersFor(query, values) {
  const used = new Set();
  collectPlaceholders(query, used);
  const missing = [];
  for (const key of used) {
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

// ── Render helpers ─────────────────────────────────

const COPY_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const OPEN_EXTERNAL_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>';

function flashCopied(btn) {
  btn.innerHTML = CHECK_SVG;
  btn.classList.add('mdh-q-copy--ok');
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.innerHTML = COPY_SVG;
    btn.classList.remove('mdh-q-copy--ok');
  }, 1200);
}

const STATUS_GLYPH = {
  pending: { glyph: '…', cls: 'mdh-q-status--pending', title: 'Replaying…', showHint: false },
  winner: { glyph: '✓', cls: 'mdh-q-status--winner', title: 'Winning query', showHint: false },
  empty: { glyph: '—', cls: 'mdh-q-status--empty', title: 'No results', showHint: false },
  skipped: { glyph: '·', cls: 'mdh-q-status--skipped', title: 'Cascade short-circuited before this query', showHint: true },
  error: { glyph: '!', cls: 'mdh-q-status--error', title: 'Replay failed', showHint: true },
};
const STATUS_CLASSES = Object.values(STATUS_GLYPH).map((s) => s.cls);

function setQueryStatus(li, status, hint) {
  const dot = li.querySelector('.mdh-q-status');
  if (!dot) return;
  const meta = STATUS_GLYPH[status] || STATUS_GLYPH.empty;
  dot.classList.remove(...STATUS_CLASSES);
  dot.classList.add(meta.cls);
  dot.textContent = meta.glyph;
  dot.title = hint ? `${meta.title} — ${hint}` : meta.title;
  li.classList.toggle('mdh-q--winner', status === 'winner');
  li.classList.toggle('mdh-q--skipped', status === 'skipped');

  let detail = li.querySelector('.mdh-q-detail');
  if (meta.showHint && hint) {
    if (!detail) {
      detail = document.createElement('span');
      detail.className = 'mdh-q-detail';
      li.appendChild(detail);
    }
    detail.classList.toggle('mdh-q-detail--error', status === 'error');
    detail.textContent = hint;
    detail.title = hint;
  } else if (detail) {
    detail.remove();
  }
}

export function resetQueryStatuses(queryListEl, status = 'pending') {
  for (const li of queryListEl.querySelectorAll('.mdh-q')) setQueryStatus(li, status);
}

export function makeConfigBlock(cfg, rowCount = 0) {
  const wrap = document.createElement('div');
  wrap.className = 'mdh-cfg';

  if (cfg.name) {
    const cfgName = document.createElement('div');
    cfgName.className = 'mdh-cfg-name';
    cfgName.textContent = cfg.name;
    cfgName.title = cfg.name;
    wrap.appendChild(cfgName);
  }

  const head = document.createElement('div');
  head.className = 'mdh-cfg-head';
  const tgt = document.createElement('span');
  tgt.className = 'mdh-q-target';
  tgt.textContent = cfg.target;
  tgt.title = `target_schema_id: ${cfg.target}`;
  const arrow = document.createElement('span');
  arrow.className = 'mdh-q-arrow';
  arrow.textContent = '←';
  const ds = document.createElement('span');
  ds.className = 'mdh-q-dataset';
  ds.textContent = cfg.dataset;
  ds.title = cfg.datasetKey ? `dataset: ${cfg.dataset} · key: ${cfg.datasetKey}` : `dataset: ${cfg.dataset}`;
  head.append(tgt, arrow, ds);
  wrap.appendChild(head);

  if (rowCount > 1) {
    const picker = document.createElement('div');
    picker.className = 'mdh-row-picker';
    const label = document.createElement('span');
    label.className = 'mdh-row-label';
    label.textContent = 'Row';
    const select = document.createElement('select');
    select.className = 'mdh-row-select';
    for (let i = 0; i < rowCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = String(i + 1);
      select.appendChild(opt);
    }
    const ofN = document.createElement('span');
    ofN.className = 'mdh-row-of';
    ofN.textContent = `of ${rowCount}`;
    picker.append(label, select, ofN);
    wrap.appendChild(picker);
  }

  if (cfg.queries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mdh-empty';
    empty.textContent = 'No queries.';
    wrap.appendChild(empty);
  } else {
    const list = document.createElement('ol');
    list.className = 'mdh-query-list';
    cfg.queries.forEach((q, i) => {
      const li = document.createElement('li');
      li.className = 'mdh-q';
      const status = document.createElement('span');
      status.className = 'mdh-q-status mdh-q-status--pending';
      status.textContent = STATUS_GLYPH.pending.glyph;
      status.title = STATUS_GLYPH.pending.title;
      const num = document.createElement('span');
      num.className = 'mdh-q-num';
      num.textContent = `${i + 1}.`;
      const lbl = document.createElement('span');
      lbl.className = 'mdh-q-name';
      lbl.textContent = q.label;
      lbl.title = q.label;
      const actions = document.createElement('span');
      actions.className = 'mdh-q-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'mdh-q-copy mdh-q-action';
      copy.title = 'Copy pipeline (with current row values) to clipboard';
      copy.innerHTML = COPY_SVG;
      const openInDm = document.createElement('button');
      openInDm.type = 'button';
      openInDm.className = 'mdh-q-open mdh-q-action';
      openInDm.title = 'Open in Dataset Management with this pipeline prefilled';
      openInDm.innerHTML = OPEN_EXTERNAL_SVG;
      actions.append(copy, openInDm);
      li.append(status, num, lbl, actions);
      list.appendChild(li);
    });
    wrap.appendChild(list);
  }
  return wrap;
}

export async function replayConfig(domain, token, cfg, values, queryListEl, signal) {
  if (!queryListEl) return null;
  const items = Array.from(queryListEl.querySelectorAll('.mdh-q'));
  const statuses = new Array(cfg.queries.length).fill(null);
  const recordStatus = (i, status, hint) => {
    statuses[i] = hint == null ? { status } : { status, hint };
    setQueryStatus(items[i], status, hint);
  };
  let foundWinner = false;
  for (let i = 0; i < cfg.queries.length; i++) {
    if (signal?.aborted) return null;
    if (foundWinner) {
      recordStatus(i, 'skipped', 'an earlier query already matched');
      continue;
    }
    const rawQuery = cfg.queries[i].raw;
    const missing = missingPlaceholdersFor(rawQuery, values);
    if (missing.length > 0) {
      recordStatus(i, 'skipped', `missing field${missing.length === 1 ? '' : 's'} in annotation: ${missing.join(', ')}`);
      continue;
    }
    const pipeline = queryToPipeline(rawQuery, { withLimit: true });
    if (!pipeline) {
      recordStatus(i, 'error', 'unknown query type');
      continue;
    }
    const substituted = substitutePlaceholders(pipeline, values);
    try {
      const data = await runAggregate(domain, token, cfg.dataset, substituted, signal);
      if (signal?.aborted) return null;
      const hits = Array.isArray(data?.result) ? data.result.length : 0;
      if (hits > 0) {
        recordStatus(i, 'winner', `${hits} hit${hits === 1 ? '' : 's'}`);
        foundWinner = true;
      } else {
        recordStatus(i, 'empty');
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      recordStatus(i, 'error', e?.message || 'request failed');
    }
  }
  return statuses;
}

// Apply previously-captured statuses to a query list without running any queries.
export function applyCachedStatuses(queryListEl, statuses) {
  const items = Array.from(queryListEl.querySelectorAll('.mdh-q'));
  statuses.forEach((st, i) => {
    if (st && items[i]) setQueryStatus(items[i], st.status, st.hint);
  });
}

export function wireCopyButtons(cfg, queryListEl, getValues) {
  queryListEl.querySelectorAll('.mdh-q-copy').forEach((btn, i) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const pipeline = queryToPipeline(cfg.queries[i].raw);
      if (!pipeline) return;
      const substituted = substitutePlaceholders(pipeline, getValues());
      try {
        await navigator.clipboard.writeText(JSON.stringify(substituted, null, 2));
        flashCopied(btn);
      } catch {
        btn.title = 'Copy failed — clipboard blocked';
      }
    });
  });
}

export function wireOpenInDmButtons(cfg, queryListEl, getValues, onOpen) {
  queryListEl.querySelectorAll('.mdh-q-open').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const pipeline = queryToPipeline(cfg.queries[i].raw);
      if (!pipeline) return;
      const substituted = substitutePlaceholders(pipeline, getValues());
      onOpen(cfg.dataset, JSON.stringify(substituted, null, 2));
    });
  });
}
