// Pure evidence model for the Diagnosis Report. Wraps culprit.js/correlate.js —
// never re-derives what they already attribute. Every item carries a stable id
// (citation target), a one-line fact, and a reliability tier. No DOM, no network.
import {
  classifyMessage,
  explainBlocker,
  classifyRejection,
  fieldProvenance,
  labelAttribution,
  matchConfigsForField,
  exportHookCandidates,
  REL,
} from './culprit.js';
import { driftDiff } from './driftDiff.js';

const idFromUrl = (url: unknown) => {
  const m = String(url || '').match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
};
const fmt = (n: unknown) =>
  typeof n === 'number' ? (Math.round(n * 100) / 100).toString() : String(n ?? '?');

export function schemaIdForDatapoint(nodes: any[], datapointId: unknown): string | null {
  if (datapointId == null) return null;
  const want = String(datapointId);
  const walk = (list: any[]): any => {
    for (const n of list || []) {
      if (n.category === 'datapoint' && String(n.id) === want) return n.schema_id || null;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(nodes);
}

// Per-field score_threshold from the schema tree; queue default as fallback.
export function fieldThresholds(
  schema: any,
  queue: any,
): { bySchemaId: Record<string, number>; defaultThreshold: number | null } {
  const bySchemaId: Record<string, number> = {};
  const walk = (list: any[]): any => {
    // In the SCHEMA tree a multivalue's children is a single tuple OBJECT (unlike
    // the content tree, where children is always an array) — live-verified 2026-07-04.
    for (const n of Array.isArray(list) ? list : list ? [list] : []) {
      if (n.category === 'datapoint' && typeof n.score_threshold === 'number')
        bySchemaId[n.id] = n.score_threshold;
      if (n.children) walk(n.children);
    }
  };
  walk(schema?.content);
  const defaultThreshold =
    typeof queue?.default_score_threshold === 'number' ? queue.default_score_threshold : null;
  return { bySchemaId, defaultThreshold };
}

// Deterministic "why (not) automated" verdict — never guesses (spec §4.2).
// `thr` (fieldThresholds result) may be passed in to avoid re-walking the schema when
// the caller already computed it (buildEvidence); omitted callers compute it themselves.
export function computeVerdict({
  annotation,
  blocker,
  content,
  queue,
  schema,
  thr,
}: Record<string, any>) {
  const a = annotation || {};
  const reasons: any[] = [];
  if (a.status === 'rejected') {
    return {
      state: 'rejected',
      severity: 'danger',
      headline: 'Rejected — see the Rejection section for who and why',
      reasons,
    };
  }
  if (a.status === 'failed_export' || a.export_failed_at) {
    return {
      state: 'export-failed',
      severity: 'danger',
      headline: 'Export failed — see the Export section',
      reasons,
    };
  }
  if (a.automated === true) {
    return {
      state: 'automated',
      severity: 'success',
      headline: 'Automated — no human touch was needed',
      reasons,
    };
  }
  if (queue && (queue.automation_level === 'never' || queue.automation_enabled === false)) {
    return {
      state: 'automation-off',
      severity: 'warning',
      headline: `Not automated — queue automation is off (automation_level: "${queue.automation_level ?? 'unknown'}")`,
      reasons: [
        {
          fact: 'Queue configuration disables automation.',
          culprit: { kind: 'queue', id: null, name: 'queue configuration' },
          reliability: REL.VERIFIED,
          evidenceId: 'verdict:automation',
        },
      ],
    };
  }
  const items = blocker?.content || [];
  if (items.length) {
    const thresholds = thr || fieldThresholds(schema, queue);
    items.forEach((raw: any, i: number) => {
      const b = explainBlocker(raw, { queue, fieldThresholds: thresholds.bySchemaId });
      if (b.type === 'low_score') {
        const sample = Array.isArray(raw?.samples) ? raw.samples[0] : null;
        const score = sample?.details?.score;
        const threshold =
          sample?.details?.threshold ??
          thresholds.bySchemaId[b.schemaId] ??
          thresholds.defaultThreshold;
        reasons.push({
          fact: `${b.schemaId || 'a field'} extraction confidence ${fmt(score)} is below the threshold ${fmt(threshold)}`,
          culprit: b.culprit,
          reliability: b.reliability,
          evidenceId: `blocker:${i}`,
        });
      } else {
        reasons.push({
          fact: b.explanation,
          culprit: b.culprit,
          reliability: b.reliability,
          evidenceId: `blocker:${i}`,
        });
      }
    });
    const errors = items.filter((x: any) => x?.type === 'error_message').length;
    const lows = items.filter((x: any) => x?.type === 'low_score').length;
    const parts = [];
    if (errors) parts.push(`${errors} blocking error${errors > 1 ? 's' : ''}`);
    if (lows) parts.push(`${lows} field${lows > 1 ? 's' : ''} below threshold`);
    if (!parts.length) parts.push(`${items.length} blocker${items.length > 1 ? 's' : ''}`);
    return {
      state: 'blocked',
      severity: 'danger',
      headline: `Not automated — ${parts.join(' + ')}`,
      reasons,
    };
  }
  if (blocker) {
    return {
      state: 'in-review',
      severity: 'warning',
      headline: 'In review — no automation blockers recorded',
      reasons,
    };
  }
  return {
    state: 'not-recorded',
    severity: 'warning',
    headline: 'Not automated — the platform recorded no blocker for this annotation',
    reasons,
  };
}

function walkDatapoints(nodes: any[], out: any[] = []): any[] {
  for (const n of nodes || []) {
    if (n.category === 'datapoint') out.push(n);
    if (n.children) walkDatapoints(n.children, out);
  }
  return out;
}

// AI verdicts merge into items as best-effort culprits (never 'verified').
function applyAttribution(item: any, attr: any) {
  if (!attr || attr.status !== 'done' || !attr.verdict) return item;
  if (item.culprit) return item; // programmatic/self-declared culprit wins
  const v = attr.verdict;
  if (!v.culprit) return item;
  return {
    ...item,
    culprit: v.culprit,
    reliability:
      attr.source === 'programmatic' ? attr.reliability || REL.BEST_EFFORT : REL.BEST_EFFORT,
    data: {
      ...item.data,
      aiExplanation: v.explanation || null,
      aiConfidence: v.confidence || null,
    },
  };
}

export function buildEvidence(input: any) {
  const {
    annotation,
    blocker,
    content,
    queue,
    schema,
    enrichment = {},
    resolved = {},
    attributions = {},
    live = null,
  } = input;
  const a = annotation || {};
  const items: any[] = [];
  const push = (it: any) => items.push(applyAttribution(it, attributions[it.id]));
  const thr = fieldThresholds(schema, queue); // per-field + default thresholds; shared by blockers and fields

  // messages → blockers section
  (a.messages || []).forEach((raw: any, i: number) => {
    const m = classifyMessage(raw);
    const field = schemaIdForDatapoint(content?.content, m.datapointId);
    push({
      id: `message:${i}`,
      section: 'blockers',
      fact: `${m.level} message${field ? ` on field ${field}` : ''}: "${m.content}"`,
      reliability: m.reliability,
      culprit: m.culprit,
      sourceRef: `/api/v1/annotations/${a.id}`,
      data: { level: m.level, field, isException: m.isException },
    });
  });

  // automation blockers
  (blocker?.content || []).forEach((raw: any, i: number) => {
    const b = explainBlocker(raw, { queue, fieldThresholds: thr.bySchemaId });
    const field = b.schemaId || schemaIdForDatapoint(content?.content, b.datapointId);
    push({
      id: `blocker:${i}`,
      section: 'blockers',
      fact: `automation blocker ${b.type}${field ? ` on field ${field}` : ''}: ${b.explanation}`,
      reliability: b.reliability,
      culprit: b.culprit,
      sourceRef: a.automation_blocker || null,
      data: { type: b.type, field },
    });
  });

  // fields (all datapoints with a schema_id; automation-written ones get attribution ids).
  // Group by schema_id: a line-item COLUMN repeats its schema_id across rows, which used to
  // emit one item (and one prompt line) PER CELL — all sharing the SAME `field:<schemaId>`
  // id, so citations/anchors collided on the first and the synthesis prompt bloated toward
  // the 48k cap on invoices. One aggregated item per schema_id fixes both (spec follow-up).
  const hooks = Object.values(resolved.hooksById || {});
  const byField = new Map();
  for (const dp of walkDatapoints(content?.content)) {
    const p = fieldProvenance(dp);
    if (!p.schemaId) continue;
    const g = byField.get(p.schemaId) || [];
    g.push(p);
    byField.set(p.schemaId, g);
  }
  for (const [schemaId, group] of byField) {
    const threshold = thr.bySchemaId[schemaId as string] ?? thr.defaultThreshold;
    const configs = group.some((p: any) => p.primary === 'data_matching')
      ? matchConfigsForField(schemaId, hooks)
      : [];
    const via = configs.length
      ? ` via ${configs.map((c) => c.hookName + (c.configName ? ` · ${c.configName}` : '')).join(', ')}`
      : '';
    if (group.length === 1) {
      const p = group[0];
      push({
        id: `field:${schemaId}`,
        section: 'fields',
        fact: `field ${schemaId} = ${JSON.stringify(p.value ?? null)} (source: ${p.primary}${via}${p.confidence != null ? `, confidence ${fmt(p.confidence)}${threshold != null ? ` vs threshold ${fmt(threshold)}` : ''}` : ''})`,
        reliability: REL.VERIFIED,
        culprit: null,
        sourceRef: `/api/v1/annotations/${a.id}/content`,
        data: { primary: p.primary, value: p.value, confidence: p.confidence, threshold, configs },
      });
    } else {
      // Line-item column: one summary item across its cells (unique id, no per-cell bloat).
      const sources = [...new Set(group.map((p: any) => p.primary))];
      const confs = group.map((p: any) => p.confidence).filter((c: any) => typeof c === 'number');
      const below = threshold != null ? confs.filter((c: any) => c < threshold).length : 0;
      const confSummary = confs.length
        ? `, confidence ${fmt(Math.min(...confs))}–${fmt(Math.max(...confs))}${threshold != null ? ` vs threshold ${fmt(threshold)} (${below} below)` : ''}`
        : '';
      push({
        id: `field:${schemaId}`,
        section: 'fields',
        fact: `line-item field ${schemaId}: ${group.length} cells (source: ${sources.join('/')}${via}${confSummary})`,
        reliability: REL.VERIFIED,
        culprit: null,
        sourceRef: `/api/v1/annotations/${a.id}/content`,
        data: {
          primary: sources[0],
          lineItem: true,
          cells: group.length,
          sources,
          threshold,
          below,
          configs,
        },
      });
    }
  }

  // labels
  if (resolved.labelsById !== undefined) {
    const { applied, notApplied } = labelAttribution({
      annotation: a,
      labelsById: resolved.labelsById,
      labelRules: resolved.labelRules || [],
    });
    for (const l of applied) {
      push({
        id: `label:${l.id}`,
        section: 'labels',
        fact: l.rule
          ? `label "${l.name}" applied by rule ${l.rule.name}`
          : `label "${l.name}" applied (no rule governs it)`,
        reliability: l.reliability,
        culprit: l.rule ? { kind: 'rule', id: null, name: l.rule.name } : null,
        sourceRef: `/api/v1/annotations/${a.id}`,
        data: { color: l.color, applied: true },
      });
    }
    for (const l of notApplied) {
      push({
        id: `label-not:${l.id}`,
        section: 'labels',
        fact: `label "${l.name}" NOT applied — rule ${l.rule.name} did not fire`,
        reliability: l.reliability,
        culprit: null,
        sourceRef: null,
        data: { color: l.color, applied: false },
      });
    }
  }

  // rejection
  const rej = classifyRejection({
    annotation: a,
    workflowActivities: Array.isArray(enrichment.workflow) ? enrichment.workflow : [],
    notes: Array.isArray(enrichment.notes) ? enrichment.notes : [],
    usersById: resolved.usersById || {},
  });
  if (rej.type !== 'none') {
    push({
      id: 'reject',
      section: 'rejection',
      fact: `rejected (${rej.type}) by ${rej.culprit?.name || 'unknown'}${rej.reason.text ? ` — reason: "${rej.reason.text}"` : ' — reason not recorded'}${rej.current ? '' : ' (historical)'}`,
      reliability: rej.reliability,
      culprit: rej.culprit,
      sourceRef: `/api/v1/annotations/${a.id}`,
      data: { when: rej.when, current: rej.current },
    });
  }

  // export
  if (a.status === 'failed_export' || a.export_failed_at) {
    const logs = Array.isArray(enrichment.hookLogs) ? enrichment.hookLogs : [];
    const { failing, candidates } = exportHookCandidates(hooks, logs);
    push({
      id: 'export',
      section: 'export',
      fact: failing
        ? `export failed in extension ${failing.hookName}${failing.error ? `: "${failing.error}"` : ''}`
        : `export failed — failing extension not in logs (${candidates.length} export extension(s) on the queue)`,
      reliability: failing ? REL.BEST_EFFORT : REL.UNAVAILABLE,
      culprit: failing ? { kind: 'hook', id: failing.hookId, name: failing.hookName } : null,
      sourceRef: '/api/v1/hooks/logs',
      data: { candidates },
    });
  }

  // explicit gaps: enrichment sources that 403'd
  for (const [kind, v] of Object.entries(enrichment)) {
    if (v === 'unavailable')
      push({
        id: `gap:${kind}`,
        section: 'blockers',
        fact: `${kind} could not be read (permission denied) — related facts are unavailable, not absent`,
        reliability: REL.UNAVAILABLE,
        culprit: null,
        sourceRef: null,
        data: {},
      });
  }

  // config drift: only present after an opt-in live re-evaluate (spec §4.5). If run
  // before synthesis starts, these join the evidence model and the narrative can
  // cite them; running it later does NOT trigger a re-synthesis.
  if (live) {
    const diff = driftDiff(a.messages, live.messages, live.matchedTriggerRules);
    diff.added.forEach((m, i) => {
      push({
        id: `drift:added:${i}`,
        section: 'drift',
        fact: `live re-evaluation ADDS message: "${m.type}: ${m.content}"`,
        reliability: REL.VERIFIED,
        culprit: null,
        sourceRef: null,
        data: { kind: 'added', message: m },
      });
    });
    diff.removed.forEach((m, i) => {
      push({
        id: `drift:removed:${i}`,
        section: 'drift',
        fact: `live re-evaluation REMOVES message: "${m.type}: ${m.content}"`,
        reliability: REL.VERIFIED,
        culprit: null,
        sourceRef: null,
        data: { kind: 'removed', message: m },
      });
    });
    push({
      id: 'drift:summary',
      section: 'drift',
      fact: `live re-evaluation against today's config: ${diff.added.length} message(s) added, ${diff.removed.length} removed, ${diff.matchedRules.length} rule(s) matched`,
      reliability: REL.VERIFIED,
      culprit: null,
      sourceRef: null,
      data: {
        added: diff.added.length,
        removed: diff.removed.length,
        matchedRules: diff.matchedRules.length,
      },
    });
  }

  items.push(...intakeEvidence(input));
  items.push(...workflowEvidence(input));

  const verdict = computeVerdict({ annotation, blocker, content, queue, schema, thr });
  return { items, verdict };
}

// Verified attachment_status vocabulary (2026-06-19): null=upload,
// processed=email attachment, extracted_archive, hook_failed, filtered_by_hook_custom.
const ARRIVAL = {
  null: 'uploaded directly',
  processed: 'arrived as an email attachment',
  extracted_archive: 'extracted from an archive',
  hook_failed: 'imported (an intake hook failed on it)',
  filtered_by_hook_custom: 'imported (filtered by an intake hook)',
};

// Compact human label for the Intake section HEADER chip — so the header no longer
// shows the raw attachment_status ("processed") while the body fact says "email
// attachment". Same vocabulary as ARRIVAL, shortened.
const ARRIVAL_LABEL = {
  null: 'upload',
  processed: 'email attachment',
  extracted_archive: 'archive',
  hook_failed: 'import (hook failed)',
  filtered_by_hook_custom: 'import (filtered)',
};
export function arrivalLabel(attachmentStatus?: string | null): string {
  const key = attachmentStatus ?? null;
  return Object.prototype.hasOwnProperty.call(ARRIVAL_LABEL, key as string)
    ? ARRIVAL_LABEL[key as keyof typeof ARRIVAL_LABEL]
    : String(attachmentStatus);
}

export function intakeEvidence({
  annotation,
  document: doc,
  parentDocument,
  relations = [],
  email,
}: Record<string, any>): any[] {
  const items: any[] = [];
  const a = annotation || {};
  if (doc) {
    const key = doc.attachment_status ?? null;
    const how = Object.prototype.hasOwnProperty.call(ARRIVAL, key)
      ? ARRIVAL[key as keyof typeof ARRIVAL]
      : `arrived (attachment_status: "${doc.attachment_status}")`;
    // Email detail only from verified keys; unknown shape → generic phrasing (V1).
    const rawSender =
      email && typeof email === 'object'
        ? email.from?.email || email.from || email.sender?.email || null
        : null;
    const sender = typeof rawSender === 'string' ? rawSender : null;
    const subject =
      email && typeof email === 'object' && typeof email.subject === 'string'
        ? email.subject
        : null;
    const extra = [sender ? `from ${sender}` : null, subject ? `subject "${subject}"` : null]
      .filter(Boolean)
      .join(', ');
    items.push({
      id: 'intake:arrival',
      section: 'intake',
      fact: `document ${how}${doc.arrived_at ? ` at ${doc.arrived_at}` : ''}${extra ? ` (${extra})` : ''}`,
      reliability: REL.VERIFIED,
      culprit: null,
      sourceRef: doc.id != null ? `/api/v1/documents/${doc.id}` : null,
      data: {
        attachmentStatus: doc.attachment_status ?? null,
        mime: doc.mime_type || null,
        sender,
        subject,
      },
    });
    if (doc.parent) {
      items.push({
        id: 'intake:split',
        section: 'intake',
        fact: `split from parent document ${parentDocument?.original_file_name ? `"${parentDocument.original_file_name}"` : `#${idFromUrl(doc.parent)}`}`,
        reliability: REL.VERIFIED,
        culprit: null,
        sourceRef: doc.parent,
        data: { parentId: idFromUrl(doc.parent) },
      });
    }
  }
  const dup = (relations || []).find((r: any) => r && r.type === 'duplicate');
  if (dup) {
    const members = (dup.annotations || []).map(idFromUrl).filter(Boolean);
    items.push({
      id: 'intake:duplicate',
      section: 'intake',
      fact: `part of a duplicate group of ${members.length} annotation(s): ${members.join(', ')}`,
      reliability: REL.VERIFIED,
      culprit: null,
      sourceRef: dup.url || null,
      data: { members },
    });
  }
  if (a.einvoice === true) {
    items.push({
      id: 'intake:einvoice',
      section: 'intake',
      fact: 'recognized as an e-invoice',
      reliability: REL.VERIFIED,
      culprit: null,
      sourceRef: null,
      data: {},
    });
  }
  return items;
}

export function workflowEvidence({
  workflowRuns = [],
  workflowSteps = [],
  enrichment = {},
}: {
  workflowRuns?: any[];
  workflowSteps?: any[];
  enrichment?: Record<string, any>;
}): any[] {
  const items: any[] = [];
  const run = (workflowRuns || [])[0];
  if (!run) return items;
  const activities = Array.isArray(enrichment.workflow) ? enrichment.workflow : [];
  const steps = [...(workflowSteps || [])].sort((x, y) => (x.ordering ?? 0) - (y.ordering ?? 0));
  const currentId = idFromUrl(run.current_step);
  const currentStep = steps.find((s) => String(s.id) === String(currentId));
  items.push({
    id: 'workflow:run',
    section: 'workflow',
    fact: `approval workflow status "${run.workflow_status}"${currentStep ? `, currently at step "${currentStep.name}"` : ''}`,
    reliability: REL.VERIFIED,
    culprit: null,
    sourceRef: run.url || null,
    data: { status: run.workflow_status, currentStepId: currentId },
  });
  for (const s of steps) {
    const matches = activities.filter(
      (ac) => ac && ac.action === 'step_started' && idFromUrl(ac.workflow_step) === String(s.id),
    );
    // Pick the most recent activity by created_at (a step can be started more than
    // once after a workflow reset); missing created_at sorts oldest, and with no
    // dated candidates at all we fall back to array order (last wins).
    const started = matches.length
      ? matches.reduce((best, ac) => {
          const bestTime = best.created_at ? Date.parse(best.created_at) : -Infinity;
          const acTime = ac.created_at ? Date.parse(ac.created_at) : -Infinity;
          return acTime >= bestTime ? ac : best;
        })
      : null;
    const assignees = (started?.assignees || []).map(idFromUrl).filter(Boolean);
    items.push({
      id: `workflow:step:${s.id}`,
      section: 'workflow',
      fact: `step ${s.ordering ?? '?'} "${s.name}" (mode ${s.mode || 'unknown'})${assignees.length ? ` — assignee(s): ${assignees.map((u: any) => `user ${u}`).join(', ')}` : ''}`,
      reliability: REL.VERIFIED,
      culprit: null,
      sourceRef: s.url || null,
      data: {
        ordering: s.ordering ?? null,
        mode: s.mode || null,
        current: String(s.id) === String(currentId),
        assignees,
      },
    });
  }
  return items;
}
