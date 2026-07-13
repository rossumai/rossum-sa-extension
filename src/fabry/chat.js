// Chat orchestration: the server owns all chat state; these actions mirror it
// into the store. One AbortController + loadId guard covers both stream and
// history loads so a chat switch can never write stale state (Inspector pattern).
import * as agentApi from '../agent/agentApi.js';
import { newAcc, foldEvents, replyText } from '../agent/agentStream.js';
import { runDeepTurn, REVIEWER_MARKER } from './deepLoop.js';
import * as store from './store.js';
import { normalizeMessages, serverMessageIndex } from './thread.js';

let controller = null;
let loadId = 0;

function friendly(err) {
  if (err?.status === 429) return 'Rate-limited by the agent — try again shortly.';
  if (err?.status === 401) return null; // handled as app-level error
  return err?.message || 'Something went wrong talking to Mr. Fabry.';
}

export async function loadChats({ more = false } = {}) {
  store.chatsLoading.value = true;
  try {
    const offset = more ? store.chats.value.length : 0;
    const page = await agentApi.listChats({ limit: 50, offset });
    store.chats.value = more ? [...store.chats.value, ...page.chats] : page.chats;
    store.chatsTotal.value = page.total;
  } catch (err) {
    if (err?.status === 401) store.error.value = err.message;
    // other failures: sidebar simply stays as-is (degradation per spec §5)
  } finally {
    store.chatsLoading.value = false;
  }
}

function abortInFlight() {
  loadId += 1;
  if (controller) controller.abort();
  controller = null;
  store.streaming.value = false;
  store.liveTurn.value = null;
  store.deepPhase.value = null;
  return loadId;
}

// `restore: true` marks a silent session-restore open (from a persisted
// fabryActiveChat id) — a 404 there just means the saved chat expired, so we
// fall back to the new-chat greeting with no error noise.
export async function openChat(chatId, { restore = false } = {}) {
  const id = abortInFlight();
  store.activeChatId.value = chatId;
  store.thread.value = [];
  store.files.value = [];
  store.sendError.value = null;
  store.threadLoading.value = true;
  try {
    const detail = await agentApi.getChat(chatId);
    if (id !== loadId) return;
    store.thread.value = normalizeMessages(detail.messages);
    store.files.value = detail.files || [];
  } catch (err) {
    if (id !== loadId) return;
    if (err?.status === 401) { store.error.value = err.message; return; }
    if (err?.status === 404) {
      // Chat is gone (expired/deleted). Reset to the greeting rather than
      // leaving a dead activeChatId + a raw 404 — the reset also clears the
      // stale persisted id via the tabState effect. A gentle note only for an
      // explicit user open, never for a silent restore.
      store.resetChatView();
      if (!restore) store.sendError.value = 'That conversation is no longer available.';
      return;
    }
    store.sendError.value = friendly(err);
  } finally {
    if (id === loadId) store.threadLoading.value = false;
  }
}

export function startNewChat() {
  abortInFlight();
  store.resetChatView();
}

function pushTurn(turn) {
  store.thread.value = [...store.thread.value, turn];
}

const BLANK_TURN = { chip: false, command: false, images: [], feedback: null, reasoning: '', tools: [], interrupted: false, questions: null, unhandled: null, error: null };

async function streamTurn(chatId, content, { images, signal } = {}) {
  const acc = newAcc();
  store.liveTurn.value = { ...acc };
  await agentApi.streamMessage(chatId, content, {
    images,
    signal,
    onEvent: (e) => {
      foldEvents(acc, [e]);
      store.liveTurn.value = { ...acc, tools: [...acc.tools] };
    },
  });
  return acc;
}

function accTurn(acc, interrupted) {
  return {
    ...BLANK_TURN, role: 'assistant', text: replyText(acc), reasoning: acc.reasoning, tools: acc.tools, interrupted,
    questions: acc.questions || null,
    unhandled: (acc.unhandled && acc.unhandled.length) ? acc.unhandled : null,
    error: acc.error || null,
  };
}

// Returns true on success, false on failure (the composer keeps its draft on false).
export async function sendMessage(text, images = []) {
  if (store.streaming.value) return false;
  const id = abortInFlight();
  controller = new AbortController();
  const signal = controller.signal;
  store.sendError.value = null;
  store.streaming.value = true;
  try {
    let chatId = store.activeChatId.value;
    if (!chatId) {
      chatId = await agentApi.createChat();
      if (id !== loadId) return false;
      store.activeChatId.value = chatId;
      if (store.personaChoice.value === 'cautious') {
        pushTurn({ ...BLANK_TURN, role: 'user', chip: true, command: true, text: '/persona cautious' });
        const prime = await streamTurn(chatId, '/persona cautious', { signal });
        if (id !== loadId) return false;
        pushTurn(accTurn(prime, false));
      }
    }
    const deep = store.deepMode.value && store.deepVerifyAllowed.value;
    if (!deep) {
      pushTurn({ ...BLANK_TURN, role: 'user', text, images });
      const acc = await streamTurn(chatId, text, { images, signal });
      if (id !== loadId) return false;
      pushTurn(accTurn(acc, false));
    } else {
      const result = await runDeepTurn({
        question: text,
        images,
        onPhase: (p) => { store.deepPhase.value = p; },
        // One user+assistant exchange in the MAIN chat. Reviewer messages
        // start with the marker → chip (display) but NOT command (Task 2).
        sendMainTurn: async (content, imgs) => {
          pushTurn({ ...BLANK_TURN, role: 'user', chip: content.startsWith(REVIEWER_MARKER), text: content, images: imgs || [] });
          const acc = await streamTurn(chatId, content, { images: imgs, signal });
          if (id !== loadId) return null;
          pushTurn(accTurn(acc, false));
          store.liveTurn.value = null;
          return { text: replyText(acc), verifiable: !acc.questions };
        },
        // Fresh critic chat per verify pass, primed cautious; folds locally so
        // the critic never hijacks the main liveTurn display.
        runCriticTurn: async (prompt) => {
          const criticId = await agentApi.createChat();
          if (id !== loadId) return null;
          const fold = async (content) => {
            const acc = newAcc();
            await agentApi.streamMessage(criticId, content, { signal, onEvent: (e) => foldEvents(acc, [e]) });
            return replyText(acc);
          };
          try {
            await fold('/persona cautious');
          } catch (err) {
            if (signal.aborted) return null;
            throw err;
          }
          if (id !== loadId) return null;
          let text2;
          try {
            text2 = await fold(prompt);
          } catch (err) {
            if (signal.aborted) return null;
            throw err;
          }
          return id === loadId ? text2 : null;
        },
      });
      if (id !== loadId) return false;
      if (!result) return false; // aborted/stale mid-loop — surface as failure like the single-turn path
      if (!result.skipped) {
        // Attach the verdict to the last assistant turn.
        const turns = store.thread.value;
        for (let i = turns.length - 1; i >= 0; i -= 1) {
          if (turns[i].role === 'assistant') {
            store.thread.value = turns.map((t, j) => (j === i ? { ...t, deep: { verdict: result.verdict, issues: result.issues, criticText: result.criticText } } : t));
            break;
          }
        }
      }
    }
    loadChats(); // refresh sidebar so the chat appears with its server preview
    return true;
  } catch (err) {
    if (id !== loadId) return false;
    if (err?.name === 'AbortError' || signal.aborted) {
      // stopStreaming already kept the partial turn
      return false;
    }
    if (err?.status === 401) { store.error.value = err.message; return false; }
    store.sendError.value = friendly(err);
    return false;
  } finally {
    if (id === loadId) {
      store.streaming.value = false;
      store.liveTurn.value = null;
      store.deepPhase.value = null;
      controller = null;
    }
  }
}

// Format the user's answers to an agent clarifying-question turn into ONE
// message. One question → the bare answer; several → numbered so the agent
// maps answer to question unambiguously.
export function formatAnswers(answers) {
  if (answers.length === 1) return answers[0].answer;
  return answers.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`).join('\n');
}

// Send the answers to an agent question as the next message in the same chat
// (verified: a plain message is the answer; the agent continues). Routes
// through sendMessage so it streams, refreshes the sidebar, and — if deep mode
// is on — the answer's turn verifies normally.
export function answerQuestions(answers) {
  return sendMessage(formatAnswers(answers));
}

export function stopStreaming() {
  if (!store.streaming.value) return;
  const acc = store.liveTurn.value;
  if (acc) pushTurn(accTurn(acc, true));
  if (controller) controller.abort();
}

// DORMANT: the 👍/👎 UI is currently hidden (AssistantTurn) because PUT
// /feedback's turn_index addresses the RAW stored history while GET /chats
// drops text-less tool-only steps, so a thread index mis-targets feedback on
// tool-using turns (live-confirmed 2026-07-13; spec §9b). Kept for a one-line
// re-enable once the backend exposes a stable per-message feedback id.
// `threadIdx` is the turn's index in store.thread; serverMessageIndex maps it.
export async function sendFeedback(threadIdx, isPositive) {
  const chatId = store.activeChatId.value;
  if (!chatId) return;
  const serverIdx = serverMessageIndex(store.thread.value, threadIdx);
  if (serverIdx < 0) return;
  try {
    await agentApi.submitFeedback(chatId, serverIdx, isPositive);
    store.thread.value = store.thread.value.map((t, i) => (i === threadIdx ? { ...t, feedback: isPositive } : t));
  } catch (err) {
    if (err?.status === 401) store.error.value = err.message;
    else store.sendError.value = friendly(err);
  }
}

export async function downloadFile(filename) {
  const chatId = store.activeChatId.value;
  if (!chatId) return;
  try {
    const blob = await agentApi.downloadChatFile(chatId, filename);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    if (err?.status === 401) store.error.value = err.message;
    else store.sendError.value = friendly(err);
  }
}
