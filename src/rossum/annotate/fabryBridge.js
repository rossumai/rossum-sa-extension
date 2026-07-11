// Content-script client for the worker's `annotate-fabry` port. Streams Fabry
// SSE chunks from the worker and parses them with the shared pure parser.
import { createSseParser } from '../../agent/agentStream.js';

export function streamFabry({ token, domain, chatId, content, images, onEvent = () => {},
  connect = (name) => chrome.runtime.connect({ name }) }) {
  return new Promise((resolve, reject) => {
    const port = connect('annotate-fabry');
    const parser = createSseParser();
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'chunk') { for (const ev of parser.feed(msg.text)) onEvent(ev); }
      else if (msg.type === 'done') { for (const ev of parser.flush()) onEvent(ev); port.disconnect(); resolve({ chatId: msg.chatId }); }
      else if (msg.type === 'error') { port.disconnect(); reject(Object.assign(new Error(msg.message || 'Agent error'), { status: msg.status })); }
    });
    port.onDisconnect.addListener(() => reject(new Error('Agent connection closed')));
    port.postMessage({ type: 'start', token, domain, chatId, content, images });
  });
}
