// Pure helpers for the Rossum Agent API stream (AI-SDK data-stream protocol).
// No network, no DOM — fully unit-testable. See spec §2 for the event vocabulary.
import { stripFences, safeParseArray } from '../mdh/llmPipeline.js';

// Known informational custom data-* parts (task plan snapshot / created-file
// link) — ignored in foldEvents' unhandled-collection below to avoid a false
// "unsupported interactive element" alarm. Surfacing them live is a future
// enhancement (files already show via FilesStrip on reload).
const BENIGN_DATA_PARTS = new Set(['data-task-snapshot', 'data-file-created']);

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
  ask_user_question: 'asking you a question',
  write_file: 'writing a file',
  search_knowledge_base: 'searching the knowledge base',
  search_elis_docs: 'searching the API docs',
  create_task: 'tracking tasks',
  update_task: 'tracking tasks',
  list_tasks: 'tracking tasks',
  execute_python: 'running a script',
  generate_mock_pdf: 'generating a test document',
  load_tool: 'loading tools',
  run_grep: 'processing output',
  run_jq: 'processing output',
};

// Human status label for the compact live status line.
type TL = keyof typeof TOOL_LABELS;

export function toolLabel(name: string): string {
  if (!name) return 'working';
  // Inline casts, not a local: a local would add an emitted statement.
  if (TOOL_LABELS[name as TL]) return TOOL_LABELS[name as TL];
  if (/aggregate|find|query|search/i.test(name)) return 'querying the collection';
  if (/list|get|read|fetch/i.test(name)) return 'reading';
  return 'working';
}

function parseLines(raw: string) {
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
    feed(chunk: string) {
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
  return { reasoning: '', text: '', finalAnswer: null, status: '', done: false, tools: [], questions: null, unhandled: [], error: null };
}

// Fold a batch of events into a mutable accumulator.
export function foldEvents(acc: any, events: any[]) {
  for (const e of events) {
    switch (e && e.type) {
      case 'reasoning-start': acc.status = 'thinking'; break;
      case 'reasoning-delta': acc.reasoning += e.delta || ''; break;
      case 'text-delta': acc.text += e.delta || ''; break;
      case 'data-final-answer': acc.finalAnswer = e.data?.text ?? acc.finalAnswer; break;
      case 'data-agent-question': acc.questions = (e.data?.questions && e.data.questions.length) ? e.data.questions : acc.questions; break;
      case 'error': case 'tool-output-error': {
        const msg = e.errorText || e.error || e.message;
        if (msg) acc.error = acc.error ? `${acc.error}\n${msg}` : String(msg);
        break;
      }
      case 'tool-input-start': acc.status = toolLabel(e.toolName); acc.tools.push(e.toolName); break;
      case 'finish': case '__done__': acc.done = true; break;
      default:
        // Forward-compatible: any UNKNOWN custom data-* part (a future
        // interactive element) is captured so the UI can show a named notice
        // instead of rendering nothing. Known data-* are handled above.
        if (typeof e?.type === 'string' && e.type.startsWith('data-') && !BENIGN_DATA_PARTS.has(e.type)
          && !acc.unhandled.some((u: any) => u.type === e.type)) {
          acc.unhandled.push({ type: e.type, data: e.data });
        }
        break;
    }
  }
  return acc;
}

export function replyText(acc: any): string {
  return acc.finalAnswer != null ? acc.finalAnswer : acc.text;
}

// Decide what a FINISHED turn shows when it has nothing normally renderable.
// null → the turn has text and/or questions; render those. Otherwise a notice,
// in priority order: stream error, then an unsupported interactive element
// (named, with raw payload), then a quiet empty note. Never render blank.
export function fallbackNotice(turn: any) {
  if ((turn.text && turn.text.length) || turn.questions) return null;
  if (turn.error) return { kind: 'error', text: turn.error };
  if (turn.unhandled && turn.unhandled.length) {
    return { kind: 'unsupported', types: turn.unhandled.map((u: any) => u.type), payloads: turn.unhandled };
  }
  return { kind: 'empty' };
}

// Extract a MongoDB aggregation pipeline (JSON array) from the reply text.
// Tries fenced ```json block(s) first, then the whole fence-stripped text, then
// each balanced [ … ] substring. Returns pretty JSON, or null.
export function extractPipeline(text: unknown) {
  if (typeof text !== 'string') return null;
  const tryParse = (s: unknown) => { const a = safeParseArray(String(s).trim()); return a ? JSON.stringify(a, null, 2) : null; };
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
  const isPipeline = (a: any) => Array.isArray(a) && a.every((s) => s && typeof s === 'object' && !Array.isArray(s));
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
