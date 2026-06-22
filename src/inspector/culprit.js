// Pure, DOM-free attribution logic — the value core of the Inspector.
// Every output carries a reliability marker; nothing is ever guessed.

export const REL = { VERIFIED: 'verified', BEST_EFFORT: 'best-effort', UNAVAILABLE: 'unavailable' };

function idFromUrl(url) { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; }
function fmtNum(n) { return typeof n === 'number' ? (Math.round(n * 100) / 100).toString() : String(n ?? '?'); }

// --- messages ---------------------------------------------------------------
// A stored annotation.messages[] item -> who produced it.
export function classifyMessage(msg) {
  const d = msg?.detail || {};
  let culprit = null;
  if (d.rule_id != null) culprit = { kind: 'rule', id: d.rule_id, name: d.rule_name || `rule ${d.rule_id}` };
  else if (d.hook_id != null) culprit = { kind: 'hook', id: d.hook_id, name: d.hook_name || `hook ${d.hook_id}` };
  return {
    level: msg?.type || 'info',
    content: msg?.content || '',
    datapointId: msg?.id != null ? String(msg.id) : null,
    culprit,
    isException: !!d.is_exception,
    requestId: d.request_id || null,
    reliability: culprit ? REL.VERIFIED : REL.UNAVAILABLE,
  };
}

// --- automation blockers ----------------------------------------------------
// One automation_blocker.content[] item -> explanation + culprit.
export function explainBlocker(item, ctx = {}) {
  const type = item?.type || 'unknown';
  const level = item?.level || null;
  const schemaId = item?.schema_id || null;
  const sample = Array.isArray(item?.samples) ? item.samples[0] : null;
  const datapointId = sample?.datapoint_id != null ? String(sample.datapoint_id) : null;

  // Best-effort producer name from the optional details.detail[0].
  const det = Array.isArray(item?.details?.detail) ? item.details.detail[0] : null;
  let culprit = null;
  let reliability = REL.VERIFIED;
  let explanation = '';

  if (type === 'low_score') {
    const score = sample?.details?.score;
    const threshold = sample?.details?.threshold ?? ctx.queue?.default_score_threshold;
    explanation = `Extraction confidence ${fmtNum(score)} is below the threshold ${fmtNum(threshold)}.`;
    culprit = { kind: 'engine', id: null, name: 'extraction engine' };
  } else if (type === 'automation_disabled') {
    explanation = `Queue automation is off (automation_level: "${ctx.queue?.automation_level ?? 'unknown'}").`;
    culprit = { kind: 'queue', id: null, name: 'queue configuration' };
  } else if (type === 'error_message') {
    explanation = 'One or more error messages are present (see the messages below); any error blocks automation.';
  } else if (det && (det.rule_name || det.hook_name)) {
    culprit = det.rule_name ? { kind: 'rule', id: null, name: det.rule_name } : { kind: 'hook', id: null, name: det.hook_name };
    reliability = REL.BEST_EFFORT;
    explanation = `Blocker of type "${type}"${schemaId ? ` on field ${schemaId}` : ''}.`;
  } else {
    explanation = `Blocker of type "${type}"${schemaId ? ` on field ${schemaId}` : ''}.`;
  }
  return { type, level, schemaId, datapointId, explanation, culprit, reliability };
}

// --- rejection taxonomy -----------------------------------------------------
function userName(url, usersById) {
  const id = idFromUrl(url);
  return usersById?.[id]?.username || (url ? `user ${id}` : null);
}

export function classifyRejection({ annotation = {}, workflowActivities = [], notes = [], usersById = {} } = {}) {
  const current = annotation.status === 'rejected';
  const historical = current || !!annotation.rejected_at;
  const wfReject = (workflowActivities || []).find((a) => a.action === 'rejected');
  const rejNote = (notes || []).find((n) => n.type === 'rejection');
  const reason = rejNote
    ? { text: rejNote.content || null, reliability: REL.VERIFIED }
    : (wfReject ? { text: wfReject.note || null, reliability: REL.VERIFIED } : { text: null, reliability: REL.UNAVAILABLE });

  if (!historical) {
    return { current, historical, type: 'none', culprit: null, reason: { text: null, reliability: REL.UNAVAILABLE }, when: null, automatic: false, reliability: REL.VERIFIED };
  }

  // Workflow signature wins: a rejected workflow_activity, regardless of automatically_rejected.
  if (wfReject) {
    return {
      current, historical, type: 'workflow',
      culprit: { kind: 'workflow', id: idFromUrl(wfReject.workflow), name: wfReject.workflow ? `Workflow #${idFromUrl(wfReject.workflow)}` : 'approval workflow' },
      reason, when: annotation.rejected_at || null,
      automatic: wfReject.created_by == null, reliability: REL.VERIFIED,
    };
  }
  // Hook/API-driven: explicitly flagged automatic; exact extension is best-effort.
  if (annotation.automatically_rejected === true) {
    return {
      current, historical, type: 'hook',
      culprit: { kind: 'extension', id: idFromUrl(annotation.rejected_by), name: userName(annotation.rejected_by, usersById) || 'automated identity' },
      reason, when: annotation.rejected_at || null, automatic: true, reliability: REL.BEST_EFFORT,
    };
  }
  // Otherwise a person rejected it.
  return {
    current, historical, type: 'manual',
    culprit: { kind: 'user', id: idFromUrl(annotation.rejected_by), name: userName(annotation.rejected_by, usersById) || 'a reviewer' },
    reason, when: annotation.rejected_at || null, automatic: false, reliability: REL.VERIFIED,
  };
}

// --- field value provenance -------------------------------------------------
// Per-field value provenance. The verified validation_sources value set is
// human / formula / connector / rules / data_matching / score / NA (+ the
// 'non_required' flag). Several of these are automation-written (data_matching
// = MDH/matching, connector = a connector hook, rules = a rule, formula = a
// schema formula). 'non_required'/'NA' are flags, never the primary.
const SRC_PRIORITY = ['human', 'data_matching', 'connector', 'rules', 'formula', 'score'];
export function fieldProvenance(dp) {
  const sources = Array.isArray(dp?.validation_sources) ? dp.validation_sources : [];
  const meaningful = sources.filter((s) => s !== 'non_required' && s !== 'NA');
  const primary = SRC_PRIORITY.find((s) => meaningful.includes(s)) || meaningful[0] || 'none';
  return {
    schemaId: dp?.schema_id || null,
    value: dp?.content?.value ?? null,
    sources,
    primary,
    confidence: typeof dp?.content?.rir_confidence === 'number' ? dp.content.rir_confidence : null,
  };
}

// Queue hooks that are matching extensions (MDH): match configs live under
// settings.configurations (modern) or settings.configs (legacy). A field whose
// source is 'data_matching' was populated by one of these.
export function matchingExtensions(hooks = []) {
  return (hooks || [])
    .filter((h) => { const s = h.settings || {}; return s.configurations || s.configs; })
    .map((h) => ({ hookId: h.id, hookName: h.name || `hook ${h.id}` }));
}

// All target schema_ids a MatchConfig writes — its primary mapping.target_schema_id
// plus any additional field mappings (verified key: target_schema_id, single or
// in an array of {dataset_key, target_schema_id}).
function configTargets(config) {
  const ids = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'target_schema_id' && typeof v === 'string') ids.add(v);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(config);
  return [...ids];
}

// Precise: which MDH hook + config actually targets THIS field (not just every
// matching hook on the queue). Returns [{hookId, hookName, configName}].
export function matchConfigsForField(schemaId, hooks = []) {
  const out = [];
  for (const h of hooks || []) {
    const s = h.settings || {};
    for (const c of (s.configurations || s.configs || [])) {
      if (configTargets(c).includes(schemaId)) {
        out.push({ hookId: h.id, hookName: h.name || `hook ${h.id}`, configName: c && c.name ? c.name : null });
      }
    }
  }
  return out;
}

// Readable text color (black/white) over a label's hex background.
export function contrastText(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#1a1a24' : '#ffffff';
}

// --- extension label attribution -------------------------------------------
// The platform records NO applier for a label (not audited; annotation.labels
// is bare URLs). So when no rule applied it, infer the extension by analyzing
// each queue hook: does its code/settings apply labels (POST /v1/labels/apply,
// apply_label, add_labels) and does it reference this label's id? (Canonical
// pattern hardcodes the label id — txscript-reference.) Always best-effort.
const LABEL_APPLY_SIG = /labels\/apply|apply_label|add_labels|remove_labels/i;

function labelIdsInBlob(blob) {
  const ids = new Set();
  for (const m of blob.matchAll(/labels\/(\d+)/g)) ids.add(m[1]); // label URLs
  // a label-ish key/const assigned an id (bare number or a /labels/<id> URL)
  for (const m of blob.matchAll(/label[\w ]*['"]?\s*[:=]\s*['"]?(?:[^'"\n]*?\/labels\/)?(\d{2,})/gi)) ids.add(m[1]);
  return [...ids];
}

// Extensions may resolve a label by NAME (GET /v1/labels?name=… or list+match)
// instead of hardcoding the id — so the name string appears in the code. Match
// it as a quoted literal or a name=/name:/name== form (precise enough to avoid
// matching common words by accident).
export function hookReferencesLabelName(blob, name) {
  if (!name || !blob) return false;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["']${esc}["']|name\\s*[=:]+\\s*["']?${esc}(?:["']|\\b)`, 'i').test(blob);
}

export function extractLabelHooks(hooks = []) {
  return (hooks || []).map((h) => {
    const code = (h.config && h.config.code) || '';
    const settings = h.settings ? JSON.stringify(h.settings) : '';
    const blob = `${code}\n${settings}`;
    let capability;
    if (LABEL_APPLY_SIG.test(blob)) capability = 'applies-labels';
    else if (h.type === 'webhook') capability = 'unknown-webhook'; // opaque external service
    else capability = 'none';
    return {
      hookId: h.id, hookName: h.name || `hook ${h.id}`, type: h.type,
      active: h.active !== false, capability, labelIds: labelIdsInBlob(blob), blob,
    };
  });
}

// Rank queue extensions as candidates for applying a given label. A hook
// "references this label" if its code/settings carry the label id OR the label
// name (extensions often resolve the id from the name at runtime).
export function labelExtensionCandidates(labelId, labelName, labelHooks = []) {
  const id = String(labelId);
  return (labelHooks || [])
    .filter((lh) => lh.capability !== 'none')
    .map((lh) => {
      const refsId = lh.labelIds.includes(id);
      const refsName = hookReferencesLabelName(lh.blob || '', labelName);
      let match; let score;
      if (lh.capability === 'applies-labels' && (refsId || refsName)) { match = 'references-label'; score = refsId ? 100 : 90; }
      else if (lh.capability === 'applies-labels') { match = 'applies-labels'; score = 40; }
      else { match = 'opaque-webhook'; score = 10; }
      if (lh.active === false) score -= 5;
      return { hookId: lh.hookId, hookName: lh.hookName, type: lh.type, match, score, by: refsId ? 'id' : (refsName ? 'name' : null) };
    })
    .sort((a, b) => b.score - a.score);
}

// Summarize the extension attribution for one applied label.
export function extensionAttribution(labelId, labelName, labelHooks = []) {
  const cands = labelExtensionCandidates(labelId, labelName, labelHooks);
  if (!cands.length) return { kind: 'none', name: null, by: null, others: [] };
  const best = cands[0];
  const others = cands.slice(1).map((c) => c.hookName);
  const kind = best.match === 'references-label' ? 'named' : best.match === 'applies-labels' ? 'likely' : 'opaque';
  return { kind, name: best.hookName, by: best.by, others };
}

// Which extensions handle export, and (best-effort) which one failed. Export
// extensions are deterministically the hooks subscribed to the export event;
// the failing one is matched from the hook logs.
export function exportHookCandidates(hooks = [], hookLogs = []) {
  const exp = (hooks || []).filter((h) => (h.events || []).some((e) => String(e).startsWith('annotation_content.export')));
  let failing = null;
  for (const l of hookLogs || []) {
    // hook log fields: hook_id, action (the export suffix lives here, not in `event`), status/log_level, message.
    const isErr = l.log_level === 'ERROR' || l.status === 'failed';
    if (isErr && String(l.action || '').includes('export')) {
      const h = exp.find((e) => e.id === l.hook_id) || (hooks || []).find((e) => e.id === l.hook_id);
      if (h) { failing = { hookId: h.id, hookName: h.name || `hook ${h.id}`, error: l.message || null }; break; }
    }
  }
  return { failing, candidates: exp.map((h) => ({ hookId: h.id, hookName: h.name || `hook ${h.id}`, active: h.active !== false })) };
}

// --- extension run timeline -------------------------------------------------
// The configured pipeline (deterministic, from hooks?queue=) overlaid with what
// actually ran (best-effort, from hooks/logs — retention-limited).
const PIPELINE_PHASES = [
  ['annotation_content.initialize', 'Initialize'],
  ['annotation_content.started', 'Started (review)'],
  ['annotation_content.updated', 'Updated'],
  ['annotation_content.confirm', 'Confirm'],
  ['annotation_content.export', 'Export'],
  ['email.received', 'Email received'],
  ['invocation.manual', 'Manual'],
];

function hookInPhase(h, phaseEvent) {
  const evs = h.events || [];
  if (evs.includes(phaseEvent)) return true;
  // bare 'annotation_content' subscribes to every annotation_content.* phase
  return phaseEvent.startsWith('annotation_content.') && evs.includes('annotation_content');
}

// Order hooks by run_after DAG (run_after holds full hook URLs). Rank = longest
// predecessor chain among hooks in the set; ties keep id order. Cycle-safe.
function rankByRunAfter(hooks) {
  const byId = new Map(hooks.map((h) => [h.id, h]));
  const idOf = (url) => { const m = String(url).match(/\/(\d+)\/?$/); return m ? Number(m[1]) : null; };
  const memo = new Map();
  const rank = (h, seen) => {
    if (memo.has(h.id)) return memo.get(h.id);
    if (seen.has(h.id)) return 0;
    seen.add(h.id);
    const preds = (h.run_after || []).map(idOf).filter((id) => byId.has(id));
    const r = preds.length ? 1 + Math.max(...preds.map((id) => rank(byId.get(id), seen))) : 0;
    memo.set(h.id, r);
    return r;
  };
  return [...hooks].sort((a, b) => rank(a, new Set()) - rank(b, new Set()) || a.id - b.id);
}

export function buildPipeline(hooks = [], hookLogs = []) {
  const active = (hooks || []).filter((h) => h.active !== false);
  const logsByHook = new Map();
  for (const l of hookLogs || []) {
    const arr = logsByHook.get(l.hook_id) || []; arr.push(l); logsByHook.set(l.hook_id, arr);
  }
  const phases = [];
  for (const [event, label] of PIPELINE_PHASES) {
    const inPhase = rankByRunAfter(active.filter((h) => hookInPhase(h, event)));
    if (!inPhase.length) continue;
    const action = event.split('.').pop();
    const nodes = inPhase.map((h) => {
      const log = (logsByHook.get(h.id) || []).find((l) => l.action === action) || null;
      let run = null;
      if (log) {
        const dur = (log.start && log.end) ? Math.max(0, new Date(log.end) - new Date(log.start)) : null;
        run = {
          failed: log.status === 'failed' || log.log_level === 'ERROR',
          message: log.message || null,
          durationMs: dur,
          statusCode: log.status_code,
          requestId: log.request_id || log.uuid || null,
        };
      }
      return { hookId: h.id, name: h.name || `hook ${h.id}`, type: h.type, run };
    });
    phases.push({ event, label, nodes });
  }
  return phases;
}

// --- detective: capability scan + candidate ranking -------------------------
export function detectRejectCapability(hook) {
  if (hook?.type === 'webhook') return 'unknown-webhook';
  const code = hook?.config?.code || '';
  return /\/reject\b/.test(code) || /['"]rejected['"]/.test(code) ? 'calls-reject' : 'no-reject-call';
}

// --- labels ----------------------------------------------------------------
// Extract the queue's label-applying rules. A label rule action carries label
// URL(s)/id(s) under any payload key containing "label" (mirrors the maintained
// dead-code detector — type/key-agnostic, since the action type string varies).
export function extractLabelRules(rules = []) {
  const out = [];
  for (const r of rules) {
    if (r?.enabled === false) continue;
    const labelIds = new Set();
    for (const a of r?.actions || []) {
      if (a?.enabled === false) continue;
      for (const [k, v] of Object.entries(a?.payload || {})) {
        if (!k.toLowerCase().includes('label')) continue;
        for (const item of (Array.isArray(v) ? v : [v])) {
          const id = idFromUrl(item) || (typeof item === 'number' ? String(item) : (/^\d+$/.test(String(item)) ? String(item) : null));
          if (id) labelIds.add(id);
        }
      }
    }
    if (labelIds.size) out.push({ ruleId: r.id, ruleName: r.name || `rule ${r.id}`, trigger: r.trigger_condition || null, labelIds: [...labelIds] });
  }
  return out;
}

// Attribute the annotation's labels: applied (by which rule, or manual) and
// rule-governed-but-not-applied (which rule didn't fire). Rule-governed only.
export function labelAttribution({ annotation = {}, labelsById = {}, labelRules = [] } = {}) {
  const def = (id) => labelsById[id] || null;
  const ruleFor = (id) => labelRules.find((lr) => lr.labelIds.includes(id)) || null;
  const appliedIds = (annotation.labels || []).map((u) => idFromUrl(u)).filter(Boolean);

  const applied = appliedIds.map((id) => {
    const lr = ruleFor(id);
    const d = def(id);
    return {
      id, name: d?.name || `label ${id}`, color: d?.color || null,
      rule: lr ? { name: lr.ruleName, trigger: lr.trigger } : null,
      reliability: lr ? REL.VERIFIED : REL.UNAVAILABLE,
    };
  });

  const appliedSet = new Set(appliedIds);
  const notApplied = [];
  const seen = new Set();
  for (const lr of labelRules) {
    for (const id of lr.labelIds) {
      if (appliedSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      const d = def(id);
      notApplied.push({ id, name: d?.name || `label ${id}`, color: d?.color || null, rule: { name: lr.ruleName, trigger: lr.trigger }, reliability: REL.VERIFIED });
    }
  }
  return { applied, notApplied };
}

export function rankRejectCandidates({ hookLogs = [], queueHooks = [], rejectedAt = null, requestId = null } = {}) {
  const ranById = new Map();
  for (const l of hookLogs) ranById.set(l.hook_id, l);
  return (queueHooks || [])
    .map((h) => {
      const log = ranById.get(h.id);
      const matchedRequestId = !!(requestId && log && log.request_id === requestId);
      const capability = detectRejectCapability(h);
      let score = 0;
      if (matchedRequestId) score += 100;
      if (log) score += 20;
      if (capability === 'calls-reject') score += 30;
      else if (capability === 'unknown-webhook') score += 5;
      return { hookId: h.id, name: h.name, capability, ran: !!log, matchedRequestId, score };
    })
    .sort((a, b) => b.score - a.score);
}
