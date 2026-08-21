// Pure view-model helpers for chat history. Server Message → Turn.
import type { Verdict } from './deepLoop.js';

export type TurnImage = { media_type: string; data: string };

/** The assistant-side fields AssistantTurn renders. Named separately because the LIVE
 *  streaming turn supplies only these — it has no role/chip/command/images yet — so the
 *  component must not demand a whole Turn. */
export type AssistantTurnView = {
  text: string;
  reasoning: string;
  tools: unknown[];
  interrupted?: boolean;
  /** Agent clarifying questions, when the turn asked instead of answering. */
  questions?: unknown[] | null;
  /** Deep-verify verdict, attached by chat.ts after a critic pass — the loop's own Verdict
   *  plus the critic's raw text. Both Verdict fields are always present. */
  deep?: (Verdict & { criticText: string | null }) | null;
  /** Supplied by the thread but not rendered here; kept so a whole Turn is assignable. */
  feedback?: boolean | null;
};

/** What normalizeMessages produces, plus the display-only extras chat.ts merges in while
 *  streaming (see its BLANK_TURN). They are optional because stored history has none. */
export type Turn = AssistantTurnView & {
  role: string;
  /** Rendered as a system-style chip rather than a message bubble. */
  chip: boolean;
  /** A `/`-command turn. The server strips these from stored history. */
  command: boolean;
  images: TurnImage[];
  feedback: boolean | null;
  /** Tool calls the client could not render. */
  unhandled?: unknown[] | null;
  error?: unknown;
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
