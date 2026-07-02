// Transport for the Rossum Agent API ("Mr. Fabry"). Streaming per-turn responses
// use the AI-SDK data-stream protocol; agentStream.js parses them. See spec §2/§5.
import { createSseParser } from './agentStream.js';

const AGENT_BASE = 'https://rossum-agent-api.tools.rossum.cloud/api/v1';
const IDLE_TIMEOUT = 90_000; // abort a turn after this long with no stream activity

let rossumToken = '';
let rossumApiUrl = '';

export function init(domain, token) {
  rossumToken = token || '';
  rossumApiUrl = domain ? `${domain}/api/v1` : '';
}

function authHeaders(extra) {
  return { 'X-Rossum-Token': rossumToken, 'X-Rossum-Api-Url': rossumApiUrl, ...(extra || {}) };
}

function agentError(status) {
  const e = new Error(status === 401
    ? 'Session expired. Open a Rossum page and click Data Storage again to reconnect.'
    : `Agent error ${status}`);
  e.status = status;
  return e;
}

// GET /health — cheap, unauthenticated liveness probe (10s timeout → false).
export async function probeAgent() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${AGENT_BASE}/health`, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.status === 'healthy';
  } catch { return false; } finally { clearTimeout(t); }
}

// POST /chats — new chat session.
export async function createChat() {
  const res = await fetch(`${AGENT_BASE}/chats`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}',
  });
  if (!res.ok) throw agentError(res.status);
  const data = await res.json();
  return data.chat_id;
}

// POST /chats/{id}/messages — stream one turn. onEvent(event) per parsed event.
// Resolves when the stream ends; aborts on `signal` or IDLE_TIMEOUT of silence.
export async function streamMessage(chatId, content, { onEvent = () => {}, signal } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let idle;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT); };
  const cleanup = () => { clearTimeout(idle); if (signal) signal.removeEventListener('abort', onAbort); };

  resetIdle();
  let res;
  try {
    res = await fetch(`${AGENT_BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content }),
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
