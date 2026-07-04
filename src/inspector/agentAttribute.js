// AI-reasoned attribution for the Inspector. The agent has its own read-only Rossum
// tools (get/search over hooks incl. code, annotations, hook logs, rules — verified
// live), so the prompt does NOT seed code/settings/logs; it gives the annotation +
// queue ids, the question, and a compact candidate list, and tells the agent to fetch
// what it needs. Pure prompt/parse here; runAttribution reuses the shared transport.
import { newAcc, foldEvents, replyText } from '../mdh/agent/agentStream.js';
import { budgetedJoin } from './promptBudget.js';

const trunc = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };

const TOOL_INSTRUCTION = 'Use your read-only tools to fetch whatever you need: each candidate extension\'s code and settings, this annotation and its content, the hook logs, and the queue\'s rules. Reason from their ACTUAL code/logs — a webhook with no readable code is opaque, so say so rather than guess. Never call any write / reject / revalidate action.';

// Compact candidate line — identity only; the agent fetches code/settings/logs itself.
function candidateLine(c) {
  return `- hook #${c.id} "${c.name}" [type=${c.type}; events=${(c.events || []).join(',')}]`;
}
function annotationLine(a) {
  return `Annotation: id ${a.id}, status ${a.status}${a.queueId ? `, queue ${a.queueId}` : ''}.`;
}

export function buildAttributionPrompt({ kind, annotation = {}, target = {}, candidates = [] }) {
  const head = [
    'You are investigating a single Rossum annotation in a READ-ONLY forensic tool. Never modify anything — only read and reason.',
    TOOL_INSTRUCTION,
  ];
  if (kind === 'label') {
    head.push(`Question: which extension applied the label "${target.name}" (id ${target.id}) to this annotation, and why?`);
  } else if (kind === 'message') {
    head.push(`Question: which extension produced this ${target.level || ''} message, and why?`);
    head.push(`Message text: ${JSON.stringify(target.content || '')}${target.schemaId ? ` (on field ${target.schemaId})` : ''}.`);
  } else if (kind === 'blocker') {
    head.push(`Question: explain this automation blocker — type "${target.type}"${target.schemaId ? ` on field ${target.schemaId}` : ''}. What does it mean, and what most likely caused it? If a specific extension is responsible, name it; otherwise use kind "unknown".`);
  } else if (kind === 'export') {
    head.push(`Question: which export extension failed for this annotation, and why?${target.error ? ` Recorded error: ${JSON.stringify(target.error)}.` : ''} Explain the failure in plain language.`);
  } else {
    head.push(`Question: which extension rejected this annotation${target.rejectedAt ? ` (rejected at ${target.rejectedAt})` : ''}, and why?`);
    if (target.reason) head.push(`Recorded rejection reason: ${target.reason}`);
  }
  head.push(annotationLine(annotation));
  head.push('Candidate extensions on this queue (fetch each one\'s code/logs with your tools as needed):');
  const middle = candidates.map(candidateLine);
  const tail = [
    'Decide which single extension is responsible. If none can be determined, use kind "unknown". If it was clearly a person (no extension involved), use kind "manual".',
    'Respond with ONLY this JSON object and nothing else: {"culprit":{"kind":"hook|webhook|rule|manual|unknown","id":<number|null>,"name":"<name>"},"confidence":"high|medium|low","explanation":"<one short paragraph>"}',
  ];
  return budgetedJoin(head, middle, tail);
}

// The first complete brace-balanced {…} object in the text (string-aware), so a
// trailing '}' in prose after the JSON can't make extraction overshoot.
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

export function parseAttribution(text) {
  if (typeof text !== 'string') return null;
  const jsonText = firstJsonObject(text);
  if (!jsonText) return null;
  try {
    const o = JSON.parse(jsonText);
    const c = o.culprit;
    const culprit = c && c.kind && c.kind !== 'unknown' && c.kind !== 'manual'
      ? { kind: String(c.kind), id: c.id == null ? null : c.id, name: String(c.name || '') }
      : (c && c.kind === 'manual' ? { kind: 'manual', id: null, name: c.name ? String(c.name) : 'manual' } : null);
    const confidence = ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low';
    return { culprit, confidence, explanation: typeof o.explanation === 'string' ? o.explanation : '' };
  } catch { return null; }
}

export async function runAttribution({ agentApi, kind, context, onPhase = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const acc = newAcc();
  let lastStatus = 'thinking'; // matches the initial onPhase above, so a reasoning-start doesn't re-emit it
  await agentApi.streamMessage(chatId, buildAttributionPrompt({ kind, ...context }), {
    signal,
    // Report the agent's live activity (reasoning / which tool it's calling) as it
    // changes, so the UI can show real progress instead of a static spinner label.
    onEvent: (ev) => { foldEvents(acc, [ev]); if (acc.status && acc.status !== lastStatus) { lastStatus = acc.status; onPhase(acc.status); } },
  });
  const raw = replyText(acc);
  const verdict = parseAttribution(raw) || { culprit: null, confidence: 'low', explanation: raw };
  return { verdict };
}

// Batched field-provenance attribution: one call for many ambiguous fields.
export function buildFieldBatchPrompt(fields = [], { annotation = {}, candidates = [] } = {}) {
  const head = [
    'You are investigating a single Rossum annotation in a READ-ONLY forensic tool. Never modify anything — only read and reason.',
    TOOL_INSTRUCTION,
    annotationLine(annotation),
    'For each field below, determine which extension, rule, or connector wrote its value (reason from the actual code/logs you fetch). If it cannot be determined, use kind "unknown".',
    `Fields:\n${fields.map((f) => `- ${f.schemaId} = ${trunc(JSON.stringify(f.value ?? null), 200)}`).join('\n')}`,
    'Candidate extensions on this queue (fetch each one\'s code/logs with your tools as needed):',
  ];
  const middle = candidates.map(candidateLine);
  const tail = ['Respond with ONLY this JSON object and nothing else: {"fields":[{"schema_id":"<id>","culprit":{"kind":"hook|webhook|rule|connector|manual|unknown","id":<number|null>,"name":"<name>"},"confidence":"high|medium|low","explanation":"<one short sentence>"}]}'];
  return budgetedJoin(head, middle, tail);
}

function normalizeVerdictObject(o) {
  const c = o && o.culprit;
  const culprit = c && c.kind && c.kind !== 'unknown'
    ? { kind: String(c.kind), id: c.id == null ? null : c.id, name: String(c.name || '') }
    : null;
  const confidence = ['high', 'medium', 'low'].includes(o && o.confidence) ? o.confidence : 'low';
  return { culprit, confidence, explanation: typeof (o && o.explanation) === 'string' ? o.explanation : '' };
}

export function parseFieldBatch(text) {
  if (typeof text !== 'string') return { fields: [] };
  const jsonText = firstJsonObject(text);
  if (!jsonText) return { fields: [] };
  try {
    const o = JSON.parse(jsonText);
    const arr = Array.isArray(o.fields) ? o.fields : [];
    return { fields: arr.filter((f) => f && f.schema_id).map((f) => ({ schema_id: String(f.schema_id), ...normalizeVerdictObject(f) })) };
  } catch { return { fields: [] }; }
}

export async function runFieldBatchAttribution({ agentApi, items, context, onPhase = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const acc = newAcc();
  let lastStatus = 'thinking';
  await agentApi.streamMessage(chatId, buildFieldBatchPrompt(items, context), {
    signal,
    onEvent: (ev) => { foldEvents(acc, [ev]); if (acc.status && acc.status !== lastStatus) { lastStatus = acc.status; onPhase(acc.status); } },
  });
  return { verdicts: parseFieldBatch(replyText(acc)).fields };
}
