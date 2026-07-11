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

// 0-based index of `turns[idx]` among server-visible messages, i.e. the
// feedback `turn_index` to PUT for that turn.
// VERIFIED live 2026-07-11: turn_index is the raw index of the message in
// ChatDetail.messages as the server returns it (per-message storage — probed
// against a real chat: PUT turn_index=1 landed feedback on messages[1], PUT
// turn_index=3 on messages[3]). The server STRIPS command/priming turns (e.g.
// `/persona cautious`) AND their assistant acks from ChatDetail.messages, so
// both are excluded here to keep client and server indices aligned. Reviewer
// turns ([deep-verify messages) are plain user messages the server KEEPS, so
// only command turns are excluded. Caveat: on live-primed chats (chip + ack
// still in the client thread this session) server-side placement was observed
// inconsistent on the dev server (2.2.0dev0) — this helper is exact for
// server-loaded threads (a chat re-opened via openChat, whose messages already
// reflect the server's stripped view).
export function serverMessageIndex(turns, idx) {
  if (!turns || idx < 0 || idx >= turns.length) return -1;
  const isExcluded = (i) => {
    const t = turns[i];
    if (t.command) return true;
    return i > 0 && turns[i - 1].command && t.role === 'assistant';
  };
  if (isExcluded(idx)) return -1;
  let n = -1;
  for (let i = 0; i <= idx; i += 1) {
    if (!isExcluded(i)) n += 1;
  }
  return n;
}
