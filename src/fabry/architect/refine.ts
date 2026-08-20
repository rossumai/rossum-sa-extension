// Pure prompt builders + reply parser for the ITERATIVE, instruction-driven
// "Refine wording" flow. The user drives it with instructions; after each one the
// agent returns the COMPLETE revised requirement as Markdown. Clarity-preserving-
// meaning, org-grounded read-only. Mirrors check.js — no network, no DOM.

const RULES = [
  "You are refining the WORDING of a single Statement-of-Work (SOW) requirement for a Rossum organization, following the user's instructions.",
  'Improve clarity, grammar, and structure. PRESERVE the requirement\'s meaning and intent: do not add, remove, or weaken any requirement beyond what an instruction explicitly asks, and keep specific names, fields, queues, thresholds, and numbers unchanged unless an instruction (or an obvious typo) says otherwise.',
  'You MAY use your READ-ONLY tools to inspect the live organization so names and identifiers are accurate (e.g. the exact queue or field name). Never create, update, or delete anything.',
  'After EACH instruction, return ONLY the COMPLETE revised requirement as Markdown — no preamble, no explanation, no code fences.',
].join('\n');

// First turn: establish the rules + the requirement, and apply the first instruction.
export function buildRefineFirst(requirement: string, instruction: string): string {
  return [RULES, '', `REQUIREMENT:\n${requirement}`, '', `INSTRUCTION:\n${instruction}`].join('\n');
}

// Follow-up turns: same chat (rules + prior proposals are in context), so just the
// next instruction. Fabry builds on its last proposal and returns the full Markdown.
export function buildRefineNext(instruction: string): string {
  return `INSTRUCTION:\n${instruction}`;
}

export function parseRefinedText(reply: unknown): string | null {
  let s = String(reply ?? '').trim();
  // Unwrap a single surrounding code fence (``` or ```markdown … ```) if the agent
  // wrapped the whole answer despite the instruction not to.
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  return s;
}
