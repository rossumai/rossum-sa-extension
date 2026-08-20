// Shared prompt-length budgeting for agent calls. The agent /messages endpoint
// rejects a content string over 50000 chars — keep head (framing/question) +
// tail (output instruction) ALWAYS and budget the middle, noting omissions.
export const MAX_PROMPT = 48000;
const NOTE_RESERVE = 160; // headroom kept free so the omission note itself never breaches the cap

export function budgetedJoin(
  head: string[], middle: string[], tail: string[], max = MAX_PROMPT,
): string {
  const sep = '\n\n';
  const kept = [];
  let used = [...head, ...tail].reduce((n, p) => n + p.length + sep.length, 0);
  let omitted = 0;
  for (const m of middle) {
    if (used + m.length + sep.length > max - NOTE_RESERVE) { omitted++; continue; }
    used += m.length + sep.length;
    kept.push(m);
  }
  if (omitted) kept.push(`(… ${omitted} more candidate item(s) omitted to stay within the length limit — fetch them with your tools if needed.)`);
  return [...head, ...kept, ...tail].join(sep);
}
