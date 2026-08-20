// Pure prompt builders + parsers for the Architect task-decomposition loop
// (ghuntley "one thing per loop"). No network, no DOM. See
// docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md.
import { stripFences, safeParseArray } from '../../mdh/llmPipeline.js';

export const MAX_PLAN_TASKS = 12;
export const MAX_TOTAL_TASKS = 20;

// Shared safety hardening applied to every write turn (ralph failure modes +
// owner guardrails). Reused by buildTaskPrompt.
const SAFETY_RULES = [
  'FIRST inspect the live organization with your tools to see what already exists — do NOT assume a queue, hook, rule, schema, engine, or field is missing without checking (a false "it is not there" leads to duplicates). Reuse or patch what already exists rather than creating a second copy.',
  'Implement it FULLY and correctly. No placeholder, stub, or "just enough to pass the check" implementation.',
  'Respect BACKWARD COMPATIBILITY: prefer additive changes; do not break or alter the behavior of existing queues, hooks, rules, schemas, or fields that other deliverables, integrations, or users may depend on.',
  'NEVER lose customer DATA or DOCUMENTS: do not delete or truncate annotations, documents, datasets, uploads, or fields that hold data; never drop collections; always prefer creating or patching over deleting. If it appears to require destroying or overwriting existing data, STOP and explain what you would need instead of doing it.',
];

export function buildPlanPrompt(deliverable: any): string {
  return [
    'You are planning how to implement a single requirement from a Statement of Work (SOW) against a live Rossum organization.',
    'Using YOUR TOOLS, inspect the live organization first, then break the requirement into a SHORT ordered list of small, concrete implementation TASKS — each task is one focused change an engineer could do in a single sitting (e.g. "create the VAT validation rule", not "set up the whole queue").',
    'Only include tasks that are NOT already satisfied — inspect before assuming something is missing.',
    `Return AT MOST ${MAX_PLAN_TASKS} tasks. Reply with ONLY a JSON array; each element is {"text": "<the task>", "acceptance": "<one line: how to verify this task is done>"}. No prose, no fences.`,
    '',
    `REQUIREMENT:\n${deliverable}`,
  ].join('\n');
}

export function buildTaskPrompt(
  deliverable: any, task: any,
  { journal = [], doneTasks = [] }: { journal?: any[]; doneTasks?: string[] } = {},
): string {
  const lines = [
    'You are implementing ONE task toward satisfying a Statement of Work (SOW) requirement against a live Rossum organization.',
    'Do THIS task only — do not do other tasks or change anything unrelated to it.',
    ...SAFETY_RULES,
  ];
  if (doneTasks.length) lines.push('', 'ALREADY DONE (do not redo):', ...doneTasks.map((t) => `- ${t}`));
  if (journal.length) {
    lines.push('', 'PREVIOUS ATTEMPTS AT THIS TASK (learn — do not repeat what failed):');
    for (const j of journal) lines.push(`- attempt ${j.attempt}: ${j.summary || '(no summary)'} → ${j.verdict || 'unknown'}. ${j.learnings || ''}`.trim());
  }
  lines.push(
    '',
    'If while doing this you discover a NECESSARY prerequisite task that is not in the plan, list it under a final "NEW TASKS:" line, one per line as `- <task> :: <one-line acceptance>` (only genuine prerequisites; omit the section if none).',
    'When done, briefly summarize exactly what you changed.',
    '',
    `SOW REQUIREMENT (context):\n${deliverable}`,
    '',
    `THIS TASK:\n${task.text}`,
    task.acceptance ? `\nDONE WHEN: ${task.acceptance}` : '',
  );
  return lines.join('\n');
}

export function buildTaskCheckPrompt(taskText: string, acceptance?: string): string {
  return [
    'You are verifying whether ONE implementation task was completed correctly in a live Rossum organization.',
    'Using YOUR TOOLS, inspect the live organization. Stay strictly READ-ONLY — never create, update, or delete anything.',
    'Inspect THOROUGHLY before concluding — do not assume something is missing without checking; a hasty "not met" is a false negative.',
    'Reply with a FIRST LINE that is exactly one of: VERDICT: PASS | VERDICT: FAIL | VERDICT: UNCERTAIN. Then cite concrete evidence, concisely.',
    '',
    `TASK:\n${taskText}`,
    acceptance ? `\nDONE WHEN: ${acceptance}` : '',
  ].join('\n');
}

// Parse the plan (JSON array of {text, acceptance}); tolerant of fences/prose; cap applied.
export function parsePlan(text: unknown, cap = MAX_PLAN_TASKS): any[] {
  const arr = extractArray(text);
  const tasks = (arr || [])
    .map((t) => (t && typeof t === 'object'
      ? { text: String(t.text || '').trim(), acceptance: String(t.acceptance || '').trim() }
      : { text: String(t || '').trim(), acceptance: '' }))
    .filter((t) => t.text);
  return tasks.slice(0, cap);
}

// Parse a "NEW TASKS:" section of `- <task> :: <acceptance>` lines. Cap applied.
export function parseDiscovered(text: unknown, cap = MAX_TOTAL_TASKS): any[] {
  const s = String(text ?? '');
  const m = s.match(/NEW TASKS:\s*([\s\S]*)$/i);
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split('\n')) {
    // Only structured list items are tasks: a bullet ("- "/"* ") OR a numbered marker
    // ("1. "/"1) "). This is the format the prompt asks for and rejects the free-form
    // prose the model commonly emits after "NEW TASKS:" (e.g. "none required — the queue
    // was already configured"), which would otherwise become a phantom write-enabled
    // task run against the LIVE org.
    const bullet = raw.trim().match(/^(?:[-*]|\d{1,3}[.)])\s+(.+)$/);
    if (!bullet) continue;
    const line = bullet[1].trim();
    // Skip the header/verdict echoes and whole-line no-op markers ("none",
    // "none needed/required", "n/a", "no new tasks", "nothing").
    if (!line || /^(new tasks:|verdict:)/i.test(line) || /^(none|n\/a|no new tasks|nothing)( needed| required)?\.?$/i.test(line)) continue;
    const idx = line.indexOf('::');
    const text2 = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const acc = idx >= 0 ? line.slice(idx + 2).trim() : '';
    if (text2) out.push({ text: text2, acceptance: acc });
    if (out.length >= cap) break;
  }
  return out;
}

// Extract a JSON array from a reply — fenced ```json block first, then the whole
// fence-stripped text, then the outermost [ … ] substring. Parsing is delegated to
// the shared lenient helpers (mdh/llmPipeline, also used by
// agentStream.extractPipeline), so a JSON-tolerance fix applies everywhere.
function extractArray(text: unknown): any[] | null {
  const s = String(text ?? '').trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence) { const a = safeParseArray(fence[1].trim()); if (a) return a; }
  const whole = safeParseArray(stripFences(s)); if (whole) return whole;
  const i = s.indexOf('['); const j = s.lastIndexOf(']');
  if (i >= 0 && j > i) { const a = safeParseArray(s.slice(i, j + 1).trim()); if (a) return a; }
  return null;
}
