// Transport for the Rossum Agent API ("Mr. Fabry"). Streaming per-turn responses
// use the AI-SDK data-stream protocol; agentStream.js parses them. See spec §2/§5.
import { createSseParser } from './agentStream.js';

/** An Error carrying the HTTP status the callers branch on (401 → session expired). */
export type AgentError = Error & { status: number };

/** One parsed data-stream event. Shaped by agentStream.js, which is still JS. */
export type AgentStreamEvent = any;

export type StreamOptions = {
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal | null;
  images?: { media_type: string; data: string }[];
  /**
   * Write-enablement for THIS turn only. `'read-write'` is the only value that exists —
   * read-only is expressed by omitting the field, which is what every other caller does.
   * The Architect implement loop is the sole caller that sets it; see the note on
   * createChat and tests/fabry-write-boundary.test.js.
   */
  mcpMode?: 'read-write';
};

const AGENT_BASE = 'https://rossum-agent-api.tools.rossum.cloud/api/v1';
const IDLE_TIMEOUT = 90_000; // abort a turn after this long with no stream activity

let rossumToken = '';
let rossumApiUrl = '';

export function init(domain: string, token: string): void {
  rossumToken = token || '';
  rossumApiUrl = domain ? `${domain}/api/v1` : '';
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'X-Rossum-Token': rossumToken, 'X-Rossum-Api-Url': rossumApiUrl, ...(extra || {}) };
}

function agentError(status: number): AgentError {
  const e = new Error(status === 401
    ? 'Session expired. Reopen the Console from a Rossum page to reconnect.'
    : `Agent error ${status}`) as AgentError;
  e.status = status;
  return e;
}

// GET /health — cheap, unauthenticated liveness probe (10s timeout → false).
export async function probeAgent(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${AGENT_BASE}/health`, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.status === 'healthy';
  } catch { return false; } finally { clearTimeout(t); }
}

// POST /chats — new chat session. Chats are read-only by default; write-enablement
// is a per-MESSAGE decision via streamMessage({ mcpMode: 'read-write' }) — the backend
// reads mcp_mode from the MESSAGE body, not the create body (verified against
// rossum-agent api/stream.py resolve_mcp_mode). The ONLY caller that enables writes is
// the Architect implement loop (implementTaskOne in architect/actions.js). Do NOT add
// write-enablement here.
export async function createChat(): Promise<string> {
  const res = await fetch(`${AGENT_BASE}/chats`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}',
  });
  if (!res.ok) throw agentError(res.status);
  const data = await res.json();
  return data.chat_id;
}

// POST /chats/{id}/messages — stream one turn. onEvent(event) per parsed event.
// Resolves when the stream ends; aborts on `signal` or IDLE_TIMEOUT of silence.
// mcpMode: pass 'read-write' to enable write-tagged MCP tools for THIS turn only
// (the Architect implement loop is the sole caller — see agentApi.createChat above).
export async function streamMessage(
  chatId: string,
  content: string,
  { onEvent = () => {}, signal, images, mcpMode }: StreamOptions = {},
): Promise<void> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let idle: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT); };
  const cleanup = () => { clearTimeout(idle); if (signal) signal.removeEventListener('abort', onAbort); };

  resetIdle();
  let res: Response;
  try {
    res = await fetch(`${AGENT_BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        content,
        ...(images && images.length ? { images } : {}),
        ...(mcpMode ? { mcp_mode: mcpMode } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (err) { cleanup(); throw err; }

  if (!res.ok || !res.body) { cleanup(); throw agentError(res.status); }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) onEvent(ev);
    }
    for (const ev of parser.flush()) onEvent(ev);
  } finally {
    cleanup();
  }
}

async function getJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders({ 'Content-Type': 'application/json' }), ...(init && init.headers) },
  });
  if (!res.ok) throw agentError(res.status);
  return res.json();
}

// GET /chats — the authenticated user's chat sessions, newest-first server-side.
export function listChats({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<any> {
  return getJson(`/chats?limit=${limit}&offset=${offset}`);
}

// GET /chats/{id} — full history: {chat_id, messages, created_at, files}.
export function getChat(chatId: string): Promise<any> {
  return getJson(`/chats/${chatId}`);
}

// GET /commands — unauthenticated per the spec; [] on any failure so the
// composer's autocomplete simply hides instead of erroring.
export async function listCommands(): Promise<any[]> {
  try {
    const res = await fetch(`${AGENT_BASE}/commands`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.commands) ? data.commands : [];
  } catch { return []; }
}

// GET /chats/{id}/files/{filename} — needs auth headers; a plain <a href> would 401.
export async function downloadChatFile(chatId: string, filename: string): Promise<Blob> {
  const res = await fetch(`${AGENT_BASE}/chats/${chatId}/files/${encodeURIComponent(filename)}`, { headers: authHeaders() });
  if (!res.ok) throw agentError(res.status);
  return res.blob();
}
