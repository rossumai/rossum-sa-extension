// Programmatic (deterministic / near-deterministic) attribution over already-loaded
// data — the "reliable" tier that runs before any AI fallback. Pure: no DOM, no network.
import { REL } from './culprit.js';

// An unattributed message (classifyMessage result, culprit === null): tie it to the
// hook/rule that produced it via the shared request_id. Hook match preferred (a hook
// log's request_id/uuid identifies its invocation); rule match is best-effort.
// Live-confirmed 2026-07-02: hook logs carry request_id AND uuid (identical, per
// invocation). We do NOT assume a message's detail.request_id is globally per-invocation
// (that could not be observed live). Instead we decide from the OBSERVED logs: VERIFIED
// only when exactly ONE hook owns the request_id here; if several hooks share it, it is
// not invocation-unique, so we DOWNGRADE to BEST_EFFORT (keeping the first as a candidate)
// rather than claim VERIFIED. Dropping it entirely would leave the message with no culprit
// when the AI tier is offline, so we keep an honest best-effort signal instead.
export function correlateMessage(
  msg: any,
  {
    hookLogs = [],
    ruleLogs = [],
    hooksById = {},
  }: { hookLogs?: any[]; ruleLogs?: any[]; hooksById?: Record<string, any> } = {},
) {
  const rid = msg && msg.requestId;
  if (!rid) return null;
  const matches = (hookLogs || []).filter(
    (l) => l && (l.request_id === rid || l.uuid === rid) && l.hook_id != null,
  );
  if (matches.length) {
    const distinct = [...new Set(matches.map((l) => l.hook_id))];
    const hookId = distinct.length === 1 ? distinct[0] : matches[0].hook_id;
    const h = (hooksById || {})[hookId];
    return {
      culprit: { kind: 'hook', id: hookId, name: (h && h.name) || `hook ${hookId}` },
      reliability: distinct.length === 1 ? REL.VERIFIED : REL.BEST_EFFORT,
    };
  }
  const rl = (ruleLogs || []).find((l) => l && l.request_id === rid);
  if (rl && rl.rule_id != null) {
    return {
      culprit: { kind: 'rule', id: rl.rule_id, name: rl.rule_name || `rule ${rl.rule_id}` },
      reliability: REL.BEST_EFFORT,
    };
  }
  return null;
}

// schema_ids a rule's actions write/target (payload.schema_id + payload.schema_ids[]).
function ruleActionTargets(rule: any) {
  const ids = new Set();
  for (const a of (rule && rule.actions) || []) {
    const p = a && a.payload;
    if (!p) continue;
    if (typeof p.schema_id === 'string') ids.add(p.schema_id);
    for (const s of Array.isArray(p.schema_ids) ? p.schema_ids : [])
      if (typeof s === 'string') ids.add(s);
  }
  return [...ids];
}

// A field whose primary source is 'rules': find a rule that fired (success) on this
// annotation whose action targets this schema_id. Best-effort (the rule could-have).
export function correlateField(
  schemaId: string,
  { ruleLogs = [], rules = [] }: { ruleLogs?: any[]; rules?: any[] } = {},
) {
  if (!schemaId) return null;
  const fired = new Set(
    (ruleLogs || [])
      .filter(
        (l) => l && (l.execution_result === 'success' || l.execution_result === 'partial_success'),
      )
      .map((l) => l.rule_id),
  );
  for (const r of rules || []) {
    if (!r || !fired.has(r.id)) continue;
    if (ruleActionTargets(r).includes(schemaId)) {
      return {
        culprit: { kind: 'rule', id: r.id, name: r.name || `rule ${r.id}` },
        reliability: REL.BEST_EFFORT,
      };
    }
  }
  return null;
}
