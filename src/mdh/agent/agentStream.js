// Pure helpers for the Rossum Agent API stream (AI-SDK data-stream protocol).
// No network, no DOM — fully unit-testable. See spec §2 for the event vocabulary.
import { stripFences, safeParseArray } from '../llmPipeline.js';

const TOOL_LABELS = {
  load_skill: 'consulting reference',
  list_datasets: 'listing datasets',
  data_storage_list_collections: 'listing collections',
  data_storage_aggregate: 'querying the collection',
  data_storage_find: 'querying the collection',
  data_storage_list_indexes: 'inspecting indexes',
  data_storage_list_search_indexes: 'inspecting search indexes',
  // Rossum resource tools (used by the Inspector's attribution agent)
  rossum_get_hook: 'reading extension code',
  rossum_list_hooks: 'listing extensions',
  rossum_list_hook_logs: 'reading extension logs',
  rossum_get_rule: 'reading a rule',
  rossum_list_rules: 'reading queue rules',
  rossum_list_rule_execution_logs: 'reading rule logs',
  rossum_get_annotation: 'reading the annotation',
  rossum_get_annotation_content: 'reading field values',
  rossum_get_queue: 'reading the queue',
  rossum_get_schema: 'reading the schema',
  rossum_list_annotations: 'searching annotations',
  rossum_search_annotations: 'searching annotations',
};

// Human status label for the compact live status line.
export function toolLabel(name) {
  if (!name) return 'working';
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (/aggregate|find|query|search/i.test(name)) return 'querying the collection';
  if (/list|get|read|fetch/i.test(name)) return 'reading';
  return 'working';
}

function parseLines(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1];
    if (payload === '[DONE]') { events.push({ type: '__done__' }); continue; }
    try { events.push(JSON.parse(payload)); } catch { /* partial/non-json → skip */ }
  }
  return events;
}

// Chunk-tolerant SSE parser. Events are separated by a blank line ("\n\n").
export function createSseParser() {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += String(chunk).replace(/\r\n?/g, '\n');
      const events = [];
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        events.push(...parseLines(raw));
      }
      return events;
    },
    flush() {
      const raw = buffer;
      buffer = '';
      return raw.trim() ? parseLines(raw) : [];
    },
  };
}

export function newAcc() {
  return { reasoning: '', text: '', finalAnswer: null, status: '', done: false, tools: [] };
}

// Fold a batch of events into a mutable accumulator.
export function foldEvents(acc, events) {
  for (const e of events) {
    switch (e && e.type) {
      case 'reasoning-start': acc.status = 'thinking'; break;
      case 'reasoning-delta': acc.reasoning += e.delta || ''; break;
      case 'text-delta': acc.text += e.delta || ''; break;
      case 'data-final-answer': acc.finalAnswer = e.data?.text ?? acc.finalAnswer; break;
      case 'tool-input-start': acc.status = toolLabel(e.toolName); acc.tools.push(e.toolName); break;
      case 'finish': case '__done__': acc.done = true; break;
      default: break;
    }
  }
  return acc;
}

export function replyText(acc) {
  return acc.finalAnswer != null ? acc.finalAnswer : acc.text;
}

// Extract a MongoDB aggregation pipeline (JSON array) from the reply text.
// Tries fenced ```json block(s) first, then the whole fence-stripped text, then
// each balanced [ … ] substring. Returns pretty JSON, or null.
export function extractPipeline(text) {
  if (typeof text !== 'string') return null;
  const tryParse = (s) => { const a = safeParseArray(String(s).trim()); return a ? JSON.stringify(a, null, 2) : null; };
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const out = tryParse(m[1]);
    if (out) return out;
  }
  const whole = tryParse(stripFences(text));
  if (whole) return whole;
  // Last resort: scan for a balanced [ … ] that parses as a *pipeline* — an
  // array of stage objects. Requiring object elements skips incidental arrays
  // like a markdown link's [x] or a [1] footnote reference that also parse as
  // valid JSON but aren't pipelines.
  const isPipeline = (a) => Array.isArray(a) && a.every((s) => s && typeof s === 'object' && !Array.isArray(s));
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '[') depth++;
      else if (text[j] === ']') {
        depth--;
        if (depth === 0) {
          const arr = safeParseArray(text.slice(i, j + 1).trim());
          if (isPipeline(arr)) return JSON.stringify(arr, null, 2);
          break;
        }
      }
    }
  }
  return null;
}
