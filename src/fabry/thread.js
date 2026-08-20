// Pure view-model helpers for chat history. Server Message → Turn.

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
}

function partsToImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'image').map((p) => ({ media_type: p.media_type, data: p.data }));
}

export function normalizeMessages(messages) {
  return (messages || []).map((msg) => {
    const text = partsToText(msg.content);
    const command = msg.role === 'user' && text.startsWith('/');
    const reviewer = msg.role === 'user' && text.startsWith('[deep-verify');
    return {
      role: msg.role,
      chip: command || reviewer,
      command,
      text,
      images: partsToImages(msg.content),
      feedback: msg.feedback ?? null,
      reasoning: '',
      tools: [],
      interrupted: false,
    };
  });
}

// Last /persona chip wins; deterministic, no guessing beyond history.
export function personaOf(turns) {
  let out = null;
  for (const t of turns || []) {
    const m = t.chip && t.text.match(/^\/persona\s+(\w+)/);
    if (m) out = m[1];
  }
  return out;
}
