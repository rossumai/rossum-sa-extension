// src/mdh/ai.js

import { aiEnabled, aiStatus, aiDownloadProgress } from './store.js';

const PROMPTS = {
  index:
    'Summarize a MongoDB index definition in 2-3 short sentences. ' +
    'Cover the indexed fields, direction, type, options, and what queries it helps. ' +
    'Use inline code (backticks) for field names and operators. No bullet points or headings.',
  searchIndex:
    'Summarize a MongoDB Atlas Search index definition in 2-3 short sentences. ' +
    'Cover the mapping type, mapped fields, analyzers, and supported queries. ' +
    'Use inline code (backticks) for field names and operators. No bullet points or headings.',
  pipeline:
    'Summarize what this MongoDB aggregation pipeline does in 1-2 short sentences. ' +
    'Mention the key stages and what data transformation they perform. ' +
    'Use inline code (backticks) for field names, operators, and stage names. No bullet points or headings.',
  error:
    'Explain this database error in 1-2 sentences. Say what went wrong and how to fix it. ' +
    'Use inline code (backticks) for field names or operators mentioned. No bullet points or headings.',
  record:
    'Summarize this database record in 1-2 sentences. Describe what it represents and its most important fields. ' +
    'Use inline code (backticks) for field names. No bullet points or headings.',
};

// Bump this when system prompts change to invalidate cached explanations
const PROMPT_VERSION = 3;

// Chrome version changes when the underlying Gemini Nano model updates
const CHROME_VERSION = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || '';

const sessions = new Map();
let availabilityCache = null;

function hashInput(input, type) {
  const str = 'v' + PROMPT_VERSION + ':' + CHROME_VERSION + ':' + type + ':' + (typeof input === 'string' ? input : JSON.stringify(input));
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return 'ai_explain_' + (hash >>> 0).toString(36);
}

export async function getAvailability() {
  if (availabilityCache !== null) return availabilityCache;
  if (typeof LanguageModel === 'undefined') {
    availabilityCache = 'unavailable';
    return availabilityCache;
  }
  try {
    availabilityCache = await LanguageModel.availability();
  } catch {
    availabilityCache = 'unavailable';
  }
  return availabilityCache;
}

export async function initAvailability() {
  const avail = await getAvailability();
  if (avail === 'unavailable') {
    aiStatus.value = 'unavailable';
    return;
  }
  const stored = await chrome.storage.local.get('aiFeaturesEnabled');
  if (stored.aiFeaturesEnabled) {
    await enableAI();
  }
}

export async function enableAI() {
  const avail = await getAvailability();
  if (avail === 'unavailable') {
    aiStatus.value = 'unavailable';
    return;
  }

  aiEnabled.value = true;
  chrome.storage.local.set({ aiFeaturesEnabled: true });

  if (avail === 'after-download' || avail === 'downloading') {
    aiStatus.value = 'downloading';
    aiDownloadProgress.value = 0;
  } else {
    aiStatus.value = 'ready';
  }

  try {
    await getOrCreateSession('index', (loaded) => {
      aiDownloadProgress.value = loaded;
      if (loaded >= 1) aiStatus.value = 'ready';
    });
    aiStatus.value = 'ready';
  } catch {
    aiStatus.value = 'idle';
    aiEnabled.value = false;
  }
}

export async function disableAI() {
  aiEnabled.value = false;
  aiStatus.value = 'idle';
  aiDownloadProgress.value = 0;
  const all = await chrome.storage.local.get(null);
  const aiKeys = Object.keys(all).filter((k) => k.startsWith('ai_explain_'));
  if (aiKeys.length > 0) await chrome.storage.local.remove(aiKeys);
  await chrome.storage.local.set({ aiFeaturesEnabled: false });
}

export async function getCached(input, type) {
  const key = hashInput(input, type);
  const result = await chrome.storage.local.get(key);
  return result[key]?.text || null;
}

async function cacheResult(input, type, text) {
  const key = hashInput(input, type);
  await chrome.storage.local.set({ [key]: { text } });
}

export async function clearCached(input, type) {
  const key = hashInput(input, type);
  await chrome.storage.local.remove(key);
}

async function getOrCreateSession(type, onDownloadProgress) {
  if (sessions.has(type)) return sessions.get(type);

  const systemPrompt = PROMPTS[type];
  if (!systemPrompt) throw new Error('Unknown AI type: ' + type);

  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: systemPrompt }],
    temperature: 0.3,
    topK: 3,
    monitor(m) {
      if (onDownloadProgress) {
        m.addEventListener('downloadprogress', (e) => onDownloadProgress(e.loaded));
      }
    },
  });

  sessions.set(type, session);
  availabilityCache = 'readily';
  return session;
}

function formatPrompt(input, type) {
  if (type === 'error') return 'Explain this error:\n' + input;
  if (type === 'pipeline') return 'Explain this pipeline:\n' + input;
  if (type === 'record') return 'Summarize this record:\n' + JSON.stringify(input, null, 2);
  return 'Explain this index:\n' + JSON.stringify(input, null, 2);
}

export async function ask(input, type, { signal } = {}) {
  const session = await getOrCreateSession(type);
  const prompt = formatPrompt(input, type);
  let result;
  try {
    result = await session.prompt(prompt, { signal });
  } catch (err) {
    if (err.name !== 'AbortError') {
      sessions.delete(type);
    }
    throw err;
  }
  await cacheResult(input, type, result);
  return result;
}

// Preload AI results in background (serialized to avoid concurrent prompts on same session)
let preloadQueue = Promise.resolve();

export function preload(input, type) {
  if (!aiEnabled.value || input == null) return;
  preloadQueue = preloadQueue.then(async () => {
    try {
      const cached = await getCached(input, type);
      if (cached) return;
      await ask(input, type);
    } catch {
      // Silently ignore — AiInsight will retry when mounted
    }
  });
}

// Backward-compatible aliases
export const getCachedExplanation = getCached;
export const clearCachedExplanation = clearCached;
export const explain = ask;

export function destroySessions() {
  for (const session of sessions.values()) session.destroy();
  sessions.clear();
  availabilityCache = null;
}

window.addEventListener('beforeunload', destroySessions);
