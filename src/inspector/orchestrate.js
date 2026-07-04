import * as store from './store.js';
import { classifyMessage, explainBlocker, classifyRejection, fieldProvenance, labelAttribution, matchConfigsForField, exportHookCandidates } from './culprit.js';
import { correlateMessage, correlateField } from './correlate.js';
import { runAttribution, runFieldBatchAttribution } from './agentAttribute.js';
import { gatherMessageContext, gatherBlockerContext, gatherExportContext, gatherFieldsContext, gatherRejectContext, gatherLabelContext } from './attributionContext.js';

export const messageKey = (i) => `message:${i}`;
export const blockerKey = (i) => `blocker:${i}`;
export const fieldKey = (schemaId) => `field:${schemaId}`;
export const labelKey = (id) => `label:${id}`;
const STD_BLOCKERS = new Set(['low_score', 'automation_disabled', 'error_message']);

function walkDatapoints(nodes, out) {
  for (const n of nodes || []) { if (n.category === 'datapoint') out.push(n); if (n.children) walkDatapoints(n.children, out); }
  return out;
}

// Enumerate everything on the annotation that needs attribution and has no verified
// self-declared cause. Pure over store.data/enrichment.
export function computeFindings(s) {
  const d = s.data.value;
  if (!d) return [];
  const a = d.annotation || {};
  const findings = [];

  // messages with no self-declared rule_id/hook_id
  (a.messages || []).forEach((raw, i) => {
    const m = classifyMessage(raw);
    if (!m.culprit) findings.push({ key: messageKey(i), kind: 'message', payload: { index: i, level: m.level, content: m.content, schemaId: m.datapointId ? null : null, requestId: m.requestId } });
  });

  // non-standard blockers (not the three verified types, and no det-name attribution)
  (d.blocker?.content || []).forEach((raw, i) => {
    const b = explainBlocker(raw, { queue: d.resolved?.queue });
    if (!STD_BLOCKERS.has(b.type) && !b.culprit) findings.push({ key: blockerKey(i), kind: 'blocker', payload: { index: i, type: b.type, schemaId: b.schemaId } });
  });

  // export: failed, and the failing hook can't be named from logs
  const failed = a.status === 'failed_export' || !!a.export_failed_at;
  if (failed) {
    const hooks = Object.values(d.resolved?.hooksById || {});
    const logs = Array.isArray(s.enrichment.value.hookLogs) ? s.enrichment.value.hookLogs : [];
    const { failing, candidates } = exportHookCandidates(hooks, logs);
    // AI only helps when the failure is genuinely ambiguous among 2+ export extensions
    // and none is named in the logs. 0 candidates ("no export extension") / 1 candidate
    // ("the only one") are already answered by the verified path.
    if (!failing && candidates.length > 1) findings.push({ key: 'export', kind: 'export', payload: { error: null } });
  }

  // fields whose source is rules/connector, or data_matching with no config naming it
  const hooks = Object.values(d.resolved?.hooksById || {});
  for (const dp of walkDatapoints(d.content?.content || [], [])) {
    const p = fieldProvenance(dp);
    if (!p.schemaId) continue;
    const ambiguous = p.primary === 'rules' || p.primary === 'connector' || (p.primary === 'data_matching' && matchConfigsForField(p.schemaId, hooks).length === 0);
    if (ambiguous) findings.push({ key: fieldKey(p.schemaId), kind: 'field', payload: { schemaId: p.schemaId, value: p.value, primary: p.primary } });
  }

  // existing AI findings (hoisted from the panels): hook rejection + applied non-rule labels
  const rej = classifyRejection({ annotation: a, workflowActivities: s.enrichment.value.workflow || [], notes: s.enrichment.value.notes || [], usersById: d.resolved?.usersById || {} });
  if (rej.type === 'hook') findings.push({ key: 'reject', kind: 'reject', payload: { reason: rej.reason?.text || null } });
  if (d.resolved?.labelsById !== undefined) {
    const { applied } = labelAttribution({ annotation: a, labelsById: d.resolved.labelsById, labelRules: d.resolved.labelRules || [] });
    for (const l of applied) if (!l.rule) findings.push({ key: labelKey(l.id), kind: 'label', payload: { id: l.id, name: l.name } });
  }
  return findings;
}

// Launch attribution for every finding: programmatic first (synchronous, free), AI in
// the background only for the residual. Guarded once-per-key; abortable per annotation.
export async function orchestrateAttributions({ store: s = store, api, agentApi, signal } = {}) {
  const d = s.data.value;
  if (!d) return;
  if (signal && signal.aborted) return; // already superseded — don't leave dangling 'loading'
  const findings = computeFindings(s);
  const enr = s.enrichment.value || {};
  const hookLogs = Array.isArray(enr.hookLogs) ? enr.hookLogs : [];
  const ruleLogs = Array.isArray(enr.ruleLogs) ? enr.ruleLogs : [];
  const rules = d.resolved?.rules || [];
  const hooksById = d.resolved?.hooksById || {};
  const aborted = () => signal && signal.aborted;
  const setDone = (key, verdict, reliability) => { if (!aborted()) s.setAttribution(key, { status: 'done', verdict, reliability, source: 'programmatic' }); };
  const ai = [];
  const fieldItems = [];
  const queued = new Set(); // dedup within this run (e.g. line-item fields repeat schema_id)

  for (const f of findings) {
    if (s.attributions.value[f.key] || queued.has(f.key)) continue; // once per key per annotation
    queued.add(f.key);
    if (f.kind === 'message') {
      const msg = classifyMessage((d.annotation.messages || [])[f.payload.index]);
      const c = correlateMessage(msg, { hookLogs, ruleLogs, hooksById });
      if (c) { setDone(f.key, { culprit: c.culprit, confidence: null, explanation: '' }, c.reliability); continue; }
      ai.push({ key: f.key, run: (onPhase) => gatherMessageContext({ api, store: s, message: f.payload }).then((context) => runAttribution({ agentApi, kind: 'message', context, onPhase, signal })) });
    } else if (f.kind === 'field') {
      const c = correlateField(f.payload.schemaId, { ruleLogs, rules });
      if (c) { setDone(f.key, { culprit: c.culprit, confidence: null, explanation: '' }, c.reliability); continue; }
      fieldItems.push({ key: f.key, schemaId: f.payload.schemaId, value: f.payload.value });
    } else if (f.kind === 'blocker') {
      ai.push({ key: f.key, run: (onPhase) => gatherBlockerContext({ api, store: s, blocker: f.payload }).then((context) => runAttribution({ agentApi, kind: 'blocker', context, onPhase, signal })) });
    } else if (f.kind === 'export') {
      ai.push({ key: f.key, run: (onPhase) => gatherExportContext({ api, store: s, error: f.payload.error }).then((context) => runAttribution({ agentApi, kind: 'export', context, onPhase, signal })) });
    } else if (f.kind === 'reject') {
      ai.push({ key: f.key, run: (onPhase) => gatherRejectContext({ api, store: s, reason: f.payload.reason }).then((context) => runAttribution({ agentApi, kind: 'reject', context, onPhase, signal })) });
    } else if (f.kind === 'label') {
      ai.push({ key: f.key, run: (onPhase) => gatherLabelContext({ api, store: s, labelId: f.payload.id, labelName: f.payload.name }).then((context) => runAttribution({ agentApi, kind: 'label', context, onPhase, signal })) });
    }
  }

  if (!s.aiAvailable.value) return; // no fallback — leave residual findings unattributed

  const pending = [];

  // Per-finding AI (background).
  for (const item of ai) {
    if (s.attributions.value[item.key]) continue;
    s.setAttribution(item.key, { status: 'loading', phase: 'thinking', source: 'ai' });
    const onPhase = (phase) => { if (aborted()) return; const cur = s.attributions.value[item.key]; if (cur && cur.status === 'loading' && cur.phase !== phase) s.setAttribution(item.key, { status: 'loading', phase, source: 'ai' }); };
    pending.push(item.run(onPhase)
      .then(({ verdict }) => { if (!aborted()) s.setAttribution(item.key, { status: 'done', verdict, source: 'ai' }); })
      .catch((e) => { if (!aborted() && e?.name !== 'AbortError') s.setAttribution(item.key, { status: 'error', error: e?.message || 'failed', source: 'ai' }); }));
  }

  // Batched field AI (one call for all residual fields).
  if (fieldItems.length) {
    for (const it of fieldItems) s.setAttribution(it.key, { status: 'loading', phase: 'thinking', source: 'ai' });
    const onPhase = (phase) => { if (aborted()) return; for (const it of fieldItems) { const cur = s.attributions.value[it.key]; if (cur && cur.status === 'loading' && cur.phase !== phase) s.setAttribution(it.key, { status: 'loading', phase, source: 'ai' }); } };
    pending.push(gatherFieldsContext({ api, store: s })
      .then((context) => runFieldBatchAttribution({ agentApi, items: fieldItems, context, onPhase, signal }))
      .then(({ verdicts }) => {
        if (aborted()) return;
        const byId = new Map(verdicts.map((v) => [v.schema_id, v]));
        for (const it of fieldItems) {
          const v = byId.get(it.schemaId);
          s.setAttribution(it.key, { status: 'done', verdict: v ? { culprit: v.culprit, confidence: v.confidence, explanation: v.explanation } : { culprit: null, confidence: 'low', explanation: '' }, source: 'ai' });
        }
      })
      .catch((e) => { if (!aborted() && e?.name !== 'AbortError') for (const it of fieldItems) s.setAttribution(it.key, { status: 'error', error: e?.message || 'failed', source: 'ai' }); }));
  }

  await Promise.allSettled(pending);
}
