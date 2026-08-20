// Pure text helpers shared by the agent surface. (The former llmchat prompt/loop
// machinery was retired 2026-07-02 in favor of the Rossum Agent API.)

export function stripFences(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

// Parse text to a pipeline array, or null if it isn't a JSON array.
export function safeParseArray(text: unknown): any[] | null {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---- AI request comment (shown above an AI-generated pipeline) --------------
export const AI_COMMENT_PREFIX = '// 🤖 AI request: ';

// Remove a leading AI-request comment (and one blank separator line, if any).
export function stripAiComment(text: unknown): string {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith(AI_COMMENT_PREFIX)) i += 1;
  if (i > 0 && i < lines.length && lines[i].trim() === '') i += 1;
  return lines.slice(i).join('\n');
}
