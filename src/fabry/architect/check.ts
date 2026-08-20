// Pure prompt builder + verdict parser for an Architect requirement check.
// One requirement → one read-only agent check → VERDICT: PASS|FAIL|UNCERTAIN.
// Mirrors deepLoop.parseVerdict, extended with UNCERTAIN. No network, no DOM.

export function buildCheckPrompt(requirement: string): string {
  return [
    'You are auditing a Rossum organization against a single requirement from a Statement of Work (SOW).',
    'Using YOUR TOOLS, inspect the live organization (queues, schemas, extensions/hooks, rules, engines, settings) and determine whether this requirement is correctly implemented. Stay strictly READ-ONLY — never create, update, or delete anything.',
    'Inspect THOROUGHLY before you conclude — search broadly and do not assume something is missing without checking; a hasty "not met" is a false negative.',
    'Reply with a FIRST LINE that is exactly one of:',
    '  VERDICT: PASS       (the requirement is met)',
    '  VERDICT: FAIL       (the requirement is not met)',
    '  VERDICT: UNCERTAIN  (you could not determine it)',
    'After the verdict line, explain your finding with concrete evidence — cite the specific queues, fields, hooks, or rules you inspected. Be concise.',
    '',
    `REQUIREMENT:\n${requirement}`,
  ].join('\n');
}

/** PASS/FAIL/UNCERTAIN plus the evidence lines the agent gave for it. */
export type CheckVerdict = { verdict: 'pass' | 'fail' | 'uncertain'; evidence: string };

export function parseCheckVerdict(text: unknown): CheckVerdict {
  const s = String(text ?? '');
  const m = s.match(/^\s*verdict:\s*(pass|fail|uncertain)\b/im);
  const verdict = (m ? m[1].toLowerCase() : 'uncertain') as CheckVerdict['verdict'];
  return { verdict, evidence: s.trim() };
}
