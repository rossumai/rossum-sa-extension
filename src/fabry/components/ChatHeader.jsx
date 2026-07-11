import { h } from 'preact';
import * as store from '../store.js';
import { chatTitle } from '../format.js';
import { personaOf } from '../thread.js';
import { personaLabel } from '../personas.js';

function kTokens(s) {
  const n = (s?.total_input_tokens || 0) + (s?.total_output_tokens || 0);
  return n > 0 ? `${(n / 1000).toFixed(1)}k tokens` : null;
}

export default function ChatHeader() {
  const id = store.activeChatId.value;
  if (!id) return null;
  const summary = store.chats.value.find((c) => c.chat_id === id);
  const firstUser = store.thread.value.find((t) => t.role === 'user' && !t.chip);
  const title = summary ? chatTitle(summary) : (firstUser?.text || 'Conversation');
  const persona = personaOf(store.thread.value);
  const tokens = kTokens(summary);
  return (
    <header class="fabry-hd">
      <span class="fabry-hd-mark">{'✦'}</span>
      <span class="fabry-hd-title" title={title}>{title}</span>
      {persona && <span class="fabry-hd-persona" title="Persona set in this session (the server does not keep persona turns in chat history)">{personaLabel(persona)}</span>}
      {tokens && <span class="fabry-hd-tokens">{tokens}</span>}
    </header>
  );
}
