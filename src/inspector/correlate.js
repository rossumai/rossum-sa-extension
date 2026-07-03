// Programmatic (deterministic / near-deterministic) attribution over already-loaded
// data — the "reliable" tier that runs before any AI fallback. Pure: no DOM, no network.
import { REL } from './culprit.js';

// An unattributed message (classifyMessage result, culprit === null): tie it to the
// hook/rule that produced it via the shared request_id. Hook match preferred (a hook
// log's request_id/uuid identifies its invocation); rule match is best-effort.
// Live-confirmed 2026-07-02: hook logs carry request_id AND uuid (identical, per
// invocation). Whether a message's detail.request_id is per-invocation (→ VERIFIED, as
// treated here) vs shared across a validation run could not be observed live (no
// annotation with messages available); if it proves shared, downgrade the hook match to
// REL.BEST_EFFORT. Either way this is safe: a non-unique match is caught by no single
// hook log matching, and the finding simply falls through to the AI tier.
export function correlateMessage(msg, { hookLogs = [], ruleLogs = [], hooksById = {} } = {}) {
  const rid = msg && msg.requestId;
  if (!rid) return null;
  const log = (hookLogs || []).find((l) => l && (l.request_id === rid || l.uuid === rid));
  if (log && log.hook_id != null) {
    const h = (hooksById || {})[log.hook_id];
    return { culprit: { kind: 'hook', id: log.hook_id, name: (h && h.name) || `hook ${log.hook_id}` }, reliability: REL.VERIFIED };
  }
  const rl = (ruleLogs || []).find((l) => l && l.request_id === rid);
  if (rl && rl.rule_id != null) {
    return { culprit: { kind: 'rule', id: rl.rule_id, name: rl.rule_name || `rule ${rl.rule_id}` }, reliability: REL.BEST_EFFORT };
  }
  return null;
}

// schema_ids a rule's actions write/target (payload.schema_id + payload.schema_ids[]).
function ruleActionTargets(rule) {
  const ids = new Set();
  for (const a of (rule && rule.actions) || []) {
    const p = a && a.payload;
    if (!p) continue;
    if (typeof p.schema_id === 'string') ids.add(p.schema_id);
    for (const s of Array.isArray(p.schema_ids) ? p.schema_ids : []) if (typeof s === 'string') ids.add(s);
  }
  return [...ids];
}

// A field whose primary source is 'rules': find a rule that fired (success) on this
// annotation whose action targets this schema_id. Best-effort (the rule could-have).
export function correlateField(schemaId, { ruleLogs = [], rules = [] } = {}) {
  if (!schemaId) return null;
  const fired = new Set(
    (ruleLogs || [])
      .filter((l) => l && (l.execution_result === 'success' || l.execution_result === 'partial_success'))
      .map((l) => l.rule_id),
  );
  for (const r of rules || []) {
    if (!r || !fired.has(r.id)) continue;
    if (ruleActionTargets(r).includes(schemaId)) {
      return { culprit: { kind: 'rule', id: r.id, name: r.name || `rule ${r.id}` }, reliability: REL.BEST_EFFORT };
    }
  }
  return null;
}
