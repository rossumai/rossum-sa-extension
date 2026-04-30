// src/mdh/ai.js

import { aiEnabled, aiStatus, aiDownloadProgress } from './store.js';
import { findHints } from './aiKnowledge.js';

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
    'Output ONLY valid JSON — an array of pipeline stages. No explanation, no markdown, no code fences, no trailing text.',
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

// Conservative cap on the user-prompt portion. Gemini Nano's context window is
// implementation-defined and not exposed as a fixed number, but ~2 000 tokens
// (~8 000 chars) leaves comfortable headroom for the system prompt + hints +
// the model's response within typical built-in budgets.
const MAX_PROMPT_CHARS = 8000;

function truncate(text) {
  if (typeof text !== 'string' || text.length <= MAX_PROMPT_CHARS) return text;
  const dropped = text.length - MAX_PROMPT_CHARS;
  return text.slice(0, MAX_PROMPT_CHARS)
    + `\n\n... [truncated, ${dropped.toLocaleString('en-US')} more characters omitted]`;
}

const FRIENDLY_TYPE_LABEL = {
  error: 'error',
  pipeline: 'pipeline',
  record: 'record',
  index: 'index',
  searchIndex: 'search index',
  nlsearch: 'request',
};

function inputTooLargeError(type, requested, available) {
  const label = FRIENDLY_TYPE_LABEL[type] || 'input';
  const err = new Error(`This ${label} is too large for the on-device AI to summarise.`);
  err.code = 'INPUT_TOO_LARGE';
  if (requested != null) err.requested = requested;
  if (available != null) err.available = available;
  return err;
}

function formatPrompt(input, type, context) {
  if (type === 'nlsearch') return input; // caller pre-formats; no hint injection

  let base;
  if (type === 'error') base = 'Explain this error:\n' + truncate(String(input));
  else if (type === 'pipeline') base = 'Explain this pipeline:\n' + truncate(String(input));
  else if (type === 'record') {
    const header = context ? 'Collection: ' + context + '\n\n' : '';
    base = header + 'What is this record about?\n' + truncate(JSON.stringify(input, null, 2));
  } else {
    base = 'Explain this index:\n' + truncate(JSON.stringify(input, null, 2));
  }

  const hints = findHints(input, type, context);
  if (hints.length > 0) {
    base +=
      '\n\nInternal context from Rossum solution architects ' +
      '(treat as expert hypothesis from people familiar with our infrastructure — ' +
      'present as a likely cause, not absolute fact, and acknowledge other reasons are possible):\n' +
      hints.map((h) => '- ' + h).join('\n');
  }
  return base;
}

export async function ask(input, type, { signal, skipCache, context } = {}) {
  const session = await getOrCreateSession(type);
  const prompt = formatPrompt(input, type, context);

  // Pre-flight: refuse early when the prompt provably won't fit. The spec
  // recently renamed the properties (inputQuota → contextWindow, inputUsage
  // → contextUsage, measureInputUsage → measureContextUsage). Accept either
  // form so we work on both old and new Chrome versions.
  const budget = session.contextWindow ?? session.inputQuota;
  const used = session.contextUsage ?? session.inputUsage ?? 0;
  const measure = session.measureContextUsage || session.measureInputUsage;
  if (typeof budget === 'number' && typeof measure === 'function') {
    try {
      const cost = await measure.call(session, prompt);
      if (typeof cost === 'number' && cost + used > budget) {
        throw inputTooLargeError(type, cost, budget - used);
      }
    } catch (err) {
      if (err && err.code === 'INPUT_TOO_LARGE') throw err;
      // measure failed for other reasons — let session.prompt() be the gate
    }
  }

  let result;
  try {
    result = await session.prompt(prompt, { signal });
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      sessions.delete(type);
      throw inputTooLargeError(type, err.requested, err.contextWindow);
    }
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
