// Explains why an aggregation stage returned nothing, via Mr. Fabry.
//
// Scope: only the FIRST empty stage is ever explained. Once a stage emits zero
// documents every later stage almost always does too, so explaining stage 5 when
// stage 2 emptied the result is noise — the useful question is which stage killed
// it. ("Almost always": $unionWith and $documents can produce rows from an empty
// input. Those are rare enough in a debugging view that one explanation on the
// first empty stage is the right trade, and the user can still read the counts.)
//
// What is sent: the stages up to and including the empty one, the per-stage
// counts, and the schema hints the AI query box already sends for this
// collection (field types, known distinct values, top values, numeric ranges).
// NOT whole documents — the hints are derived in the browser, and it is usually
// a distinct value that explains a $match matching nothing.
import { newAcc, foldEvents, replyText } from '../../agent/agentStream.js';
import { schemaHintParts } from './agentQuery.js';

// Index of the first ACTIVE stage whose preview came back empty, or -1.
// `previews` is StagesView's map (active index → { docs } | { error }); a stage
// still loading, or one that errored, is not "empty" and must not be reported —
// an error already shows its own message, and guessing during a load would fire
// an explanation that a moment later is wrong.
export function firstEmptyStage(previews, activeCount) {
  for (let i = 0; i < activeCount; i++) {
    const info = previews?.[i];
    if (!info || info.error) return -1;
    if (Array.isArray(info.docs) && info.docs.length === 0) return i;
  }
  return -1;
}

// Stable identity for one explanation request: the collection plus the exact
// stages that produced the empty result. Used to dedupe (the same empty pipeline
// is never explained twice) and to abort a stale stream when the pipeline moves
// on. Returns null when there is nothing to explain.
export function explainSignature(collection, stages, emptyIndex, rawStages = null) {
  if (!collection || emptyIndex < 0) return null;
  const run = JSON.stringify(stages.slice(0, emptyIndex + 1));
  // The written form is part of the identity: replacing a literal with a
  // variable that holds the same value leaves the substituted stages identical
  // while changing what the correct advice is.
  const written = Array.isArray(rawStages) && rawStages.length === stages.length
    ? JSON.stringify(rawStages.slice(0, emptyIndex + 1))
    : '';
  return `${collection}::${emptyIndex}::${run}::${written}`;
}

// ── Result cache ────────────────────────────────────────────────────────────
// Keyed by the signature, so an explanation survives the panel unmounting and
// remounting — switching to List/Table and back, or any re-render that briefly
// drops the empty stage. Without it Mr. Fabry re-investigates an identical
// pipeline from scratch, which costs an agent round-trip and shows the user a
// spinner for an answer that was already on screen a moment ago.
//
// Successful answers ONLY. Caching a failure would turn one transient network
// blip into a permanently stuck error for that pipeline, with no way to retry
// short of editing it. Session-lived and in memory: nothing here is persisted,
// and the collection is part of every key.
const CACHE_MAX = 20;
const cache = new Map();

export function cachedExplanation(signature) {
  if (!signature) return null;
  return cache.get(signature) || null;
}

export function cacheExplanation(signature, text) {
  if (!signature || !text) return;
  // Re-insert so the Map's insertion order is a true recency order.
  cache.delete(signature);
  cache.set(signature, text);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function _resetExplanationCache() { cache.clear(); }

// Pure: the prompt. Kept separate from the transport so its content is
// assertable without a network layer.
export function buildEmptyStagePrompt({
  collection, stages, rawStages = null, variables = null,
  emptyIndex, counts = [], inputCount = null, hints = null,
}) {
  const upTo = stages.slice(0, emptyIndex + 1);
  const culprit = upTo[emptyIndex];
  const parts = [];
  // Context FIRST, and explicitly Rossum. Without it the agent — a Rossum
  // platform persona — read this as an off-topic MongoDB question and refused
  // outright: "this isn't related to the Rossum document processing platform,
  // I'm a Rossum platform specialist…". Master Data Hub IS Rossum, so say so.
  parts.push(
    'You are helping debug a Master Data Hub query in Rossum.',
    '',
    'Context: Master Data Hub stores a customer\'s master data — vendors, items, cost centres,',
    'GL accounts and so on — as collections in Rossum\'s Data Storage. Rossum MDH matching hooks',
    'query those collections with MongoDB aggregation pipelines to look values up while a',
    'document is being extracted. A Rossum solution architect is debugging one of those',
    'pipelines right now, in the Dataset Management console of the Rossum SA extension.',
    '',
    'One stage of their pipeline returned ZERO documents. Diagnose why, and say how to fix it.',
    '',
    `Collection: ${collection}`,
    `Documents in the collection before the pipeline: ${inputCount == null ? 'unknown' : inputCount}`,
    '',
  );

  // The stage AS WRITTEN, before variable substitution. Without this the agent
  // only ever sees rendered literals and cannot tell a hard-coded value from an
  // unfilled variable — which is the single most common cause of an empty
  // result and needs the opposite fix ("fill the variable", not "loosen the
  // filter").
  const rawUpTo = Array.isArray(rawStages) && rawStages.length === stages.length
    ? rawStages.slice(0, emptyIndex + 1)
    : null;
  if (rawUpTo) {
    parts.push(
      'The pipeline AS WRITTEN by the user, with {variable} placeholders intact:',
      JSON.stringify(rawUpTo, null, 2),
      '',
      'The same pipeline AS RUN, after variable substitution — this is what the database saw:',
      JSON.stringify(upTo, null, 2),
      '',
    );
  } else {
    parts.push(
      'The pipeline, up to and including the stage that came back empty:',
      JSON.stringify(upTo, null, 2),
      '',
    );
  }

  if (variables && variables.length) {
    parts.push('Variables in this pipeline:');
    for (const v of variables) {
      const type = v.type && v.type !== 'auto' ? v.type : 'auto';
      parts.push(v.isSet
        ? `  {${v.name}} = ${JSON.stringify(v.value)}  (type: ${type})`
        : `  {${v.name}} = NOT SET  (type: ${type})`);
    }
    parts.push(
      '',
      'How substitution works here, because it changes what a stage actually means:',
      '  - An UNSET variable substitutes as an empty string. So `{"country": "{country}"}` with',
      '    {country} unset runs as `{"country": ""}` and matches nothing. When that is the cause,',
      '    the fix is to fill the variable in, NOT to change the query.',
      '  - Substitution is type-aware: a variable typed `number` substitutes as a JSON number',
      '    even inside quotes, so `"{qty}"` can run as `5`, not `"5"`.',
      '',
    );
  }

  parts.push(
    `The stage that emptied the result is index ${emptyIndex} (0-based): ${JSON.stringify(culprit)}`,
    '',
    'Document count after each stage:',
  );
  for (let i = 0; i <= emptyIndex; i++) {
    const key = Object.keys(upTo[i] || {})[0] || '?';
    const c = counts[i];
    parts.push(`  ${i}. ${key} -> ${typeof c === 'number' ? c : 'unknown'} docs`);
  }
  if (hints) {
    parts.push('', 'Data summary for this collection (derived from real documents):');
    parts.push(...schemaHintParts(hints));
  }
  parts.push(
    '',
    'You are the diagnostic panel inside that console. The reader is a Rossum solution',
    'architect who already knows their own pipeline — they want the cause, not a lesson.',
    '',
    'This IS a Rossum question. Master Data Hub is a Rossum feature, these collections live in',
    'Rossum\'s Data Storage, and this pipeline is what a Rossum MDH hook runs to match data on a',
    'Rossum document. Do NOT question whether the topic is in scope, do not describe what you',
    'are or are not a specialist in, and do not offer to help with something else instead.',
    'Answer the diagnostic question.',
    '',
    'Answer in GitHub-flavoured Markdown, in this shape:',
    '  - one short sentence naming the most likely cause;',
    '  - then up to three "- " bullets of evidence, each citing a real field name or value',
    '    from the data summary above where it contradicts the query;',
    '  - then a final line: "**Next step:** " and one concrete change to try.',
    'Use `backticks` for field names, values and operators. Bold sparingly. No headings.',
    '',
    'Start with the cause. Do NOT open with a preamble, a restatement of the question, an',
    'apology, a caveat about scope or relevance, or any remark about what you are or are not',
    'able to do — those are noise in a debugging panel and the reader will not read past them.',
    '',
    'Rules: do not invent field names or values that are not in the data summary or the',
    'pipeline. If the summary does not explain it, say so in one sentence rather than',
    'guessing. Do not restate the pipeline back to the reader. Never suggest a stage that',
    'writes (`$out`, `$merge`).',
  );
  return parts.join('\n');
}

// Runs one turn in a fresh chat, primed read-only. Streams text through
// `onText`; resolves with the final text.
export async function runExplainEmpty({ agentApi, prompt, signal, onText = () => {} }) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return { chatId, text: '' };
  // Same cautious priming the other read-only Fabry surfaces use. Defence in
  // depth only — this turn asks a question and applies nothing.
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  if (signal?.aborted) return { chatId, text: '' };
  const acc = newAcc();
  await agentApi.streamMessage(chatId, prompt, {
    signal,
    onEvent: (ev) => {
      foldEvents(acc, [ev]);
      if (!signal?.aborted) onText(replyText(acc));
    },
  });
  return { chatId, text: replyText(acc) };
}
