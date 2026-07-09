// Worker-side Fabry transport. Lives in the service worker because a content
// script cannot call the cross-origin Fabry host under MV3 CORS; the worker has
// the host permission and a chrome-extension:// origin (which Fabry allows).
// Supports vision: images go in a top-level `images` array (verified 2026-07-07).

export const AGENT_BASE = 'https://rossum-agent-api.tools.rossum.cloud/api/v1';

function agentError(status) {
  const e = new Error(status === 401 ? 'Session expired (401)' : `Agent error ${status}`);
  e.status = status;
  return e;
}

// Aborts the turn if no stream chunk arrives for `idleMs` (a slow/stalled Fabry
// vision turn otherwise hangs the UI forever — verified >180s on a real doc).
export async function runFabryTurn({ fetchImpl, base, headers, chatId, content, images, onChunk, signal, idleMs = 75000 }) {
  const H = { ...headers, 'Content-Type': 'application/json' };
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = null;
  const clearIdle = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const resetIdle = () => { clearIdle(); timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, idleMs); };
  const onExtAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onExtAbort, { once: true }); }
  // Rejects when the turn is aborted (idle timeout or caller signal); raced against each read
  // so a stalled reader that never resolves still unblocks.
  const aborted = new Promise((_, reject) => {
    const fire = () => reject(timedOut ? new Error('Agent timed out') : new Error('Agent aborted'));
    if (ctrl.signal.aborted) fire();
    else ctrl.signal.addEventListener('abort', fire, { once: true });
  });
  aborted.catch(() => {}); // avoid an unhandled rejection when read() wins the race
  const cleanup = () => { clearIdle(); if (signal) signal.removeEventListener('abort', onExtAbort); };

  try {
    let id = chatId;
    if (!id) {
      const r = await fetchImpl(`${base}/chats`, { method: 'POST', headers: H, body: '{}', signal: ctrl.signal });
      if (!r.ok) throw agentError(r.status);
      id = (await r.json()).chat_id;
    }
    const body = JSON.stringify(images && images.length ? { content, images } : { content });
    const r = await fetchImpl(`${base}/chats/${id}/messages`, { method: 'POST', headers: H, body, signal: ctrl.signal });
    if (!r.ok || !r.body) throw agentError(r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    resetIdle();
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      resetIdle();
      onChunk(dec.decode(value, { stream: true }));
    }
    return { chatId: id };
  } finally {
    cleanup();
  }
}
