// Pure prompt + parser for AI-generated deliverable titles (read-only). No net/DOM.
export function buildTitlePrompt(text: string): string {
  return [
    'Write a short, specific title for this Rossum Statement-of-Work requirement.',
    'Rules: at most 6 words; Title Case; name the concrete thing (queue/rule/field/integration) when possible; no surrounding quotes; no trailing punctuation.',
    'Reply with ONLY the title on one line — nothing else.',
    '',
    `REQUIREMENT:\n${text}`,
  ].join('\n');
}
export function parseTitle(reply: unknown): string | null {
  const line =
    String(reply ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length) || '';
  return line
    .replace(/^["'`*#\s]+/, '')
    .replace(/["'`*.\s]+$/, '')
    .slice(0, 80);
}
