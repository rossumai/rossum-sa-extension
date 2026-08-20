// Pure view-model helpers for chat history. Server Message → Turn.

export type TurnImage = { media_type: string; data: string };

/** What normalizeMessages produces. chat.js adds display-only extras (a deep-verify
 *  verdict, agent questions) while streaming; those join this type when chat.js converts. */
export type Turn = {
  role: string;
  /** Rendered as a system-style chip rather than a message bubble. */
  chip: boolean;
  /** A `/`-command turn. The server strips these from stored history. */
  command: boolean;
  text: string;
  images: TurnImage[];
  feedback: boolean | null;
  reasoning: string;
  tools: unknown[];
  interrupted: boolean;
};

/** A message as GET /chats/{id} returns it. */
export type ServerMessage = { role: string; content: unknown; feedback?: boolean | null };

function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text as string).join('\n');
}

function partsToImages(content: unknown): TurnImage[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'image').map((p) => ({ media_type: p.media_type, data: p.data }));
}

export function normalizeMessages(messages?: ServerMessage[] | null): Turn[] {
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
export function personaOf(turns?: Turn[] | null): string | null {
  let out: string | null = null;
  for (const t of turns || []) {
    const m = t.chip && t.text.match(/^\/persona\s+(\w+)/);
    if (m) out = m[1];
  }
  return out;
}
