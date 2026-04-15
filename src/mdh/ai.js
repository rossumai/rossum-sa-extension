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
    'Explain what this database record is about in 1-2 sentences. The collection name is provided as a hint to the record\'s domain — use it to narrow interpretation, but do not restate it. ' +
    'Interpret the values to infer what the record represents — e.g., for a product, what kind of product it is; for a vendor, what they do; for a transaction, its nature and purpose. ' +
    'Focus on meaning, not enumeration. Do not list field names or restate raw values — the user can see the fields on screen. ' +
    'No bullet points or headings.',
  nlsearch:
    'You are a MongoDB expert. You are given the current aggregation pipeline and the user\'s request. ' +
    'Modify the pipeline according to the request — add, remove, or change stages as needed. ' +
    'If the request describes a completely new query, replace the pipeline entirely. ' +
    'Output ONLY valid JSON — an array of pipeline stages. No explanation, no markdown, no code fences, no trailing text. ' +
    'Always include a $limit stage (default 50).',
};

// Chrome version changes when the underlying Gemini Nano model updates
const CHROME_VERSION = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || '';

const sessions = new Map();
let availabilityCache = null;

// Hash covers everything that determines the model's output:
// the system prompt, the formatted user prompt, and the model version.
// Editing any PROMPTS entry or formatPrompt template auto-invalidates affected cache entries.
function hashInput(input, type, context) {
  const systemPrompt = PROMPTS[type] || '';
  const userPrompt = formatPrompt(input, type, context);
  const str = CHROME_VERSION + '\u0001' + systemPrompt + '\u0001' + userPrompt;
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
    availabilityCache = await LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
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

export async function needsDownload() {
  const avail = await getAvailability();
  return avail === 'after-download' || avail === 'downloading';
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
    // Session pre-creation failed — keep AI enabled but don't claim ready.
    // Features stay hidden (gated on 'ready'). User can toggle off/on to retry.
    aiStatus.value = 'idle';
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

export async function getCached(input, type, context) {
  const key = hashInput(input, type, context);
  const result = await chrome.storage.local.get(key);
  return result[key]?.text || null;
}

async function cacheResult(input, type, context, text) {
  const key = hashInput(input, type, context);
  await chrome.storage.local.set({ [key]: { text } });
}

export async function clearCached(input, type, context) {
  const key = hashInput(input, type, context);
  await chrome.storage.local.remove(key);
}

async function getOrCreateSession(type, onDownloadProgress) {
  if (sessions.has(type)) return sessions.get(type);

  const systemPrompt = PROMPTS[type];
  if (!systemPrompt) throw new Error('Unknown AI type: ' + type);

  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: systemPrompt }],
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
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

function formatPrompt(input, type, context) {
  if (type === 'error') return 'Explain this error:\n' + input;
  if (type === 'pipeline') return 'Explain this pipeline:\n' + input;
  if (type === 'record') {
    const header = context ? 'Collection: ' + context + '\n\n' : '';
    return header + 'What is this record about?\n' + JSON.stringify(input, null, 2);
  }
  if (type === 'nlsearch') return input; // user query + fields are already formatted by caller
  return 'Explain this index:\n' + JSON.stringify(input, null, 2);
}

export async function ask(input, type, { signal, skipCache, context } = {}) {
  const session = await getOrCreateSession(type);
  const prompt = formatPrompt(input, type, context);
  let result;
  try {
    result = await session.prompt(prompt, { signal });
  } catch (err) {
    if (err.name !== 'AbortError') {
      sessions.delete(type);
    }
    throw err;
  }
  // Destroy one-shot sessions to prevent conversation history accumulation
  if (type === 'nlsearch') {
    session.destroy();
    sessions.delete(type);
  }
  if (!skipCache) await cacheResult(input, type, context, result);
  return result;
}

// Preload AI results in background (serialized to avoid concurrent prompts on same session)
const preloadQueues = new Map();

export function preload(input, type, context) {
  if (!aiEnabled.value || input == null) return;
  const prev = preloadQueues.get(type) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      const cached = await getCached(input, type, context);
      if (cached) return;
      await ask(input, type, { context });
    } catch {
      // Silently ignore — AiInsight will retry when mounted
    }
  });
  preloadQueues.set(type, next);
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
