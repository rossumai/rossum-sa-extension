// Client-orchestrated verify-and-refine loop over the Rossum Agent API ("Mr. Fabry").
//
// The agent GENERATES a pipeline (JSON-only; it does not run anything). The CLIENT
// then EXECUTES it against the collection via the injected `api.aggregate` — the same
// read client the whole MDH app uses — to VERIFY it two ways:
//   1. mechanically (execution error / 0 rows), and
//   2. semantically — a second agent turn judges whether the ACTUAL result rows answer
//      the request (restored from the retired llmchat loop).
// On any bad signal it asks the agent to refine, up to MAX_CORRECTIONS times.
//
// READ-ONLY is enforced client-side: `screen()` rejects any pipeline containing a write
// stage ANYWHERE ($out/$merge, via stripWriteStages) — never executed or applied.
// Returns { pipelineText, note, transcript } (transcript = the run's chat for the modal).
import { newAcc, foldEvents, replyText, extractPipeline } from '../../agent/agentStream.js';
import { safeParseArray } from '../llmPipeline.js';
import { stripWriteStages } from '../pipelineOps.js';

export const MAX_CORRECTIONS = 2; // 1 initial generation + up to 2 refinements
export const MAX_ROWS = 50; // default result cap (matches the retired llmchat loop)
export const VERIFY_MIN_SCORE = 50; // semantic verifier: accept at/above this score
const SAMPLE_DOCS = 3;

function hasWriteStage(arr: unknown): boolean {
  return Array.isArray(arr) && stripWriteStages(arr).length !== arr.length;
}

export function capRows(arr: any) {
  if (!Array.isArray(arr)) return arr;
  const has = (k: string) => arr.some((s) => s && typeof s === 'object' && k in s);
  if (has('$count') || has('$limit')) return arr;
  return [...arr, { $limit: MAX_ROWS }];
}

// Data-driven schema-hint blocks (restored from the retired design). Each is
// emitted only when its data is present. Verified live to improve precision:
// known values fix coded-field misses; numeric-string fields fix string-vs-number
// compares; search-index awareness unlocks $search the model can't otherwise use.
// The data-driven schema hints, all derived in the browser from records already loaded.
export type SchemaHints = {
  knownValues?: Record<string, unknown[]> | null;
  topValues?: Record<string, { values: unknown[]; more?: number }> | null;
  ranges?: Record<string, { min: unknown; max: unknown }> | null;
  numericStringFields?: string[] | null;
  searchIndexes?: { name: string; fields: string[] | 'all'; synonyms?: boolean }[] | null;
  fieldTypes?: Record<string, string> | null;
  arrayPaths?: string[] | null;
};

export function schemaHintParts({
  knownValues = null,
  topValues = null,
  ranges = null,
  numericStringFields = null,
  searchIndexes = null,
  fieldTypes = null,
  arrayPaths = null,
}: SchemaHints = {}) {
  const parts: string[] = [];
  if (fieldTypes && Object.keys(fieldTypes).length > 0) {
    const items = Object.keys(fieldTypes)
      .sort()
      .map((f) => `${f}:${fieldTypes[f]}`);
    let line = `Field types — ${items.join(', ')}.`;
    const EXT = new Set(['date', 'objectId', 'timestamp', 'binary', 'uuid', 'regex']);
    if (Object.values(fieldTypes).some((t) => EXT.has(t))) {
      line +=
        ' Fields typed date/objectId/timestamp are stored as MongoDB extended JSON (e.g. {"$date": ...}); reference them by the field name and treat them as that type — there is no ".$date" sub-field.';
    }
    parts.push(line);
  }
  if (knownValues && Object.keys(knownValues).length > 0) {
    const items = Object.entries(knownValues).map(([f, vals]) => `${f} ∈ {${vals.join(', ')}}`);
    parts.push(`Known values (use the EXACT stored form) — ${items.join('; ')}`);
  }
  if (topValues && Object.keys(topValues).length > 0) {
    const items = Object.entries(topValues).map(
      ([f, v]) => `${f} often ∈ {${v.values.join(', ')}}${v.more ? ` (+${v.more} more)` : ''}`,
    );
    parts.push(`Most common values (not exhaustive; match the stored form) — ${items.join('; ')}`);
  }
  if (ranges && Object.keys(ranges).length > 0) {
    const items = Object.entries(ranges).map(([f, r]) => `${f}: ${r.min}…${r.max}`);
    parts.push(`Numeric ranges — ${items.join('; ')}.`);
  }
  if (Array.isArray(arrayPaths) && arrayPaths.length > 0) {
    parts.push(`Array fields (use $unwind to reach elements) — ${arrayPaths.join(', ')}.`);
  }
  if (Array.isArray(numericStringFields) && numericStringFields.length > 0) {
    parts.push(
      `Fields stored as strings of digits — to compare them numerically, convert with $toInt inside $expr (e.g. {$expr:{$gt:[{$toInt:"$field"},N]}}): ${numericStringFields.join(', ')}.`,
    );
  }
  if (Array.isArray(searchIndexes) && searchIndexes.length > 0) {
    const items = searchIndexes.map(
      (i) =>
        `'${i.name}' (${i.fields === 'all' ? 'all fields' : i.fields.join(', ')}${i.synonyms ? '; synonyms' : ''})`,
    );
    parts.push(
      `Atlas Search indexes available: ${items.join('; ')}. For free-text / fuzzy / description matching prefer $search as the FIRST stage with the matching index (e.g. {$search:{index:"<name>",text:{query:"...",path:"<field>"}}}); for exact value filters use $match.`,
    );
  }
  return parts;
}

// Read-only generation prompt. Carries the retired-design rules + the data-driven
// schema hints + the CURRENT pipeline (so the agent iterates on it).
export function buildGenPrompt({
  request,
  collection,
  fields = [],
  samples = null,
  currentPipeline = '',
  knownValues = null,
  topValues = null,
  ranges = null,
  numericStringFields = null,
  searchIndexes = null,
  fieldTypes = null,
  arrayPaths = null,
}: {
  // `request` is optional only because the whole argument is: the original signature defaults it
  // to `{}`, and narrowing that would change the emitted function.
  request?: string;
  collection?: string | null;
  fields?: string[];
  samples?: any[] | null;
  currentPipeline?: string;
} & SchemaHints = {}) {
  const parts = [
    'You are a MongoDB expert building a READ-ONLY aggregation pipeline for a Rossum Data Storage collection in the Dataset Management tool.',
    'Modify the current pipeline per the request — add, remove, or change stages as needed. If the request describes a completely new query, replace it entirely.',
    'READ-ONLY: produce only a read/aggregate pipeline. Never use $out, $merge, or any stage that writes, updates, or deletes data. If the request would require a write, output an empty array [].',
    'Do NOT call any tools, list datasets, or query the API — build the pipeline from the fields, sample documents, and schema hints below; the application runs and verifies it for you.',
    `Always end with a \`$limit\` of at most ${MAX_ROWS} (use a smaller value when the request asks for fewer, e.g. "top 5"); a \`$count\` pipeline is exempt. Never return more than ${MAX_ROWS} documents.`,
    'Use the EXACT stored value forms shown in the samples/known values (e.g. "NET30", not "net 30"). For free-text / fuzzy matching use case-insensitive regex (or $search when a text index is listed below).',
    `Collection: ${collection || '(none)'}.`,
  ];
  if (fields.length) parts.push(`Available fields: ${fields.join(', ')}.`);
  if (Array.isArray(samples) && samples.length) {
    parts.push(
      `Sample documents (how values are actually stored):\n${JSON.stringify(samples.slice(0, SAMPLE_DOCS))}`,
    );
  }
  parts.push(
    ...schemaHintParts({
      knownValues,
      topValues,
      ranges,
      numericStringFields,
      searchIndexes,
      fieldTypes,
      arrayPaths,
    }),
  );
  parts.push(
    `Current pipeline:\n${currentPipeline && currentPipeline.trim() ? currentPipeline.trim() : '[]'}`,
  );
  parts.push(
    'Respond with ONLY the pipeline: a single valid JSON array of stages. No prose, no explanation, no markdown, no code fences, no text before or after.',
  );
  parts.push(`Request: ${request}`);
  return parts.join('\n\n');
}

// Correction prompt sent into the SAME chat.
export function buildFixPrompt({
  verdict,
  samples = null,
}: {
  verdict: { kind: string; error?: string; issue?: string };
  samples?: any[] | null;
}) {
  const parts: string[] = [];
  if (verdict.kind === 'error')
    parts.push(`That pipeline failed with error: ${verdict.error || 'unknown error'}.`);
  else if (verdict.kind === 'mismatch')
    parts.push(
      `That pipeline ran but its results do not correctly answer the request${verdict.issue ? `: ${verdict.issue}` : ''}.`,
    );
  else
    parts.push(
      'That pipeline returned 0 matching documents — likely a value-format or field mismatch.',
    );
  if (Array.isArray(samples) && samples.length) {
    parts.push(
      `Sample documents (how values are actually stored):\n${JSON.stringify(samples.slice(0, SAMPLE_DOCS))}`,
    );
  }
  parts.push(
    'Fix it so it correctly answers the original request. Stay READ-ONLY (no $out/$merge/writes), do not call tools, and respond with ONLY the JSON array — no prose or markdown.',
  );
  return parts.join('\n\n');
}

// Semantic verifier prompt: judge whether the ACTUAL result rows answer the request.
export function buildVerifyPrompt({
  request,
  pipelineText,
  rows,
}: {
  request: string;
  pipelineText: string;
  rows?: any[] | null;
}) {
  return [
    'You are reviewing whether a MongoDB aggregation pipeline you wrote correctly answers a request for a Rossum Data Storage collection.',
    `Original request: ${request}`,
    `Pipeline:\n${pipelineText}`,
    `A sample of the rows it actually returned (up to 3):\n${JSON.stringify(rows || [])}`,
    'Judge whether these results correctly and completely answer the request — right fields, right filter, right sort/limit, and values matching the intent.',
    'Respond with ONLY a JSON object: {"answersRequest": true|false, "score": <0-100>, "issue": "<short reason if it does not>"}. No prose, no markdown.',
  ].join('\n\n');
}

export function parseVerdict(text: unknown) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return {
      answersRequest: o.answersRequest !== false,
      score: typeof o.score === 'number' ? o.score : null,
      issue: typeof o.issue === 'string' ? o.issue : '',
    };
  } catch {
    return null;
  }
}

// One agent turn → { raw, reasoning, pipeline }.
async function generate(agentApi: any, chatId: string, content: string, signal?: AbortSignal) {
  const acc = newAcc();
  await agentApi.streamMessage(chatId, content, {
    signal,
    onEvent: (ev: unknown) => foldEvents(acc, [ev]),
  });
  const raw = replyText(acc);
  return { raw, reasoning: acc.reasoning, pipeline: extractPipeline(raw) };
}

// Semantic verify turn (same chat). Lenient: an unparseable verdict does NOT block
// (matches the retired "can't judge → accept"). Returns { ok, issue, raw, reasoning }.
async function semanticVerify(agentApi: any, chatId: string, ctx: any, signal?: AbortSignal) {
  const acc = newAcc();
  await agentApi.streamMessage(chatId, buildVerifyPrompt(ctx), {
    signal,
    onEvent: (ev: unknown) => foldEvents(acc, [ev]),
  });
  const raw = replyText(acc);
  const v = parseVerdict(raw);
  const ok = !v || (v.answersRequest && (v.score == null || v.score >= VERIFY_MIN_SCORE));
  return { ok, issue: v?.issue || '', score: v?.score ?? null, raw, reasoning: acc.reasoning };
}

// Screen a generated pipeline before it is executed or applied.
function screen(pipelineText: string | null) {
  const arr = safeParseArray(pipelineText);
  if (!arr) return { block: { pipelineText: null, note: { kind: 'no-pipeline' } } };
  if (!arr.length) return { block: { pipelineText: null, note: { kind: 'declined' } } };
  if (hasWriteStage(arr)) return { block: { pipelineText: null, note: { kind: 'blocked' } } };
  const capped = capRows(arr);
  return { pipelineText: JSON.stringify(capped, null, 2), arr: capped };
}

// Execute a screened (read-only, capped) pipeline. Verdict:
//  { kind:'ok', rowCount, rows } | { kind:'empty' } | { kind:'error', error } | { kind:'unrun' }
// The mechanical verdict, plus the 'mismatch' the SEMANTIC verifier adds — one type, because
// `giveUp`/`refineReason` take either.
type Verdict = {
  kind: 'ok' | 'empty' | 'error' | 'unrun' | 'mismatch';
  rowCount?: number;
  rows?: any[];
  error?: string;
  issue?: string;
};

async function verify(
  api: any,
  collection: string | null | undefined,
  arr: any[],
  signal?: AbortSignal,
): Promise<Verdict> {
  if (hasWriteStage(arr))
    return {
      kind: 'error',
      error: 'write stages ($out/$merge) are not permitted; produce a read-only pipeline',
    };
  if (!collection) return { kind: 'unrun' };
  try {
    const res = await api.aggregate(collection, arr, { signal });
    const rows = res?.result || [];
    return rows.length
      ? { kind: 'ok', rowCount: rows.length, rows: rows.slice(0, SAMPLE_DOCS) }
      : { kind: 'empty' };
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    return { kind: 'error', error: (e as any)?.message || String(e) };
  }
}

function verdictLabel(v: Verdict) {
  switch (v.kind) {
    case 'ok':
      return `Ran the query — ${v.rowCount} row${v.rowCount === 1 ? '' : 's'}`;
    case 'empty':
      return 'Ran the query — 0 matching rows';
    case 'error':
      return `Execution error: ${v.error || 'unknown'}`;
    case 'unrun':
      return 'Applied without running (no collection selected)';
    default:
      return v.kind;
  }
}
function blockLabel(note: { kind: string }) {
  switch (note.kind) {
    case 'no-pipeline':
      return 'The agent did not return a pipeline.';
    case 'declined':
      return 'The agent declined — no read-only query is possible for that request.';
    case 'blocked':
      return 'Blocked: that pipeline would modify data (write stage).';
    default:
      return note.kind;
  }
}
function refineReason(v: Verdict) {
  if (v.kind === 'error') return 'Refine: fix the execution error.';
  if (v.kind === 'mismatch')
    return `Refine: the result doesn't fully answer the request${v.issue ? ` — ${v.issue}` : ''}.`;
  return 'Refine: the query returned no matches.';
}

// Core generate → verify (mechanical + semantic) → refine loop against an already
// created + persona-primed chat. Appends turns to the shared `transcript` array.
// `onPhase` receives a stable key ('generate'|'run'|'verify'|'refine') as the loop
// advances — the AgentBox footer phase tracker renders from these.
// Returns { pipelineText, note }. note.kind ∈ verified|refined|empty|error|unrun|no-pipeline|declined|blocked.
// One turn as shown in the transcript modal.
type Turn = { role: 'user' | 'assistant' | 'system'; text: string; reasoning?: string };

type LoopArgs = {
  api: any;
  agentApi: any;
  chatId: string;
  request: string;
  collection?: string | null;
  fields?: string[];
  samples?: any[] | null;
  currentPipeline?: string;
  hints?: SchemaHints;
  transcript: Turn[];
  onPhase: (phase: string) => void;
  signal?: AbortSignal;
};

async function runLoop({
  api,
  agentApi,
  chatId,
  request,
  collection,
  fields,
  samples,
  currentPipeline,
  hints,
  transcript,
  onPhase,
  signal,
}: LoopArgs) {
  onPhase('generate');
  transcript.push({ role: 'user', text: request });
  const g0 = await generate(
    agentApi,
    chatId,
    buildGenPrompt({ request, collection, fields, samples, currentPipeline, ...hints }),
    signal,
  );
  transcript.push({ role: 'assistant', text: g0.raw, reasoning: g0.reasoning });
  const first = screen(g0.pipeline);
  if (first.block) {
    transcript.push({ role: 'system', text: blockLabel(first.block.note) });
    return first.block;
  }
  let { pipelineText, arr } = first;

  let refined = false;
  const done = (rowCount?: number) => ({
    pipelineText,
    note: { kind: refined ? 'refined' : 'verified', rowCount },
  });
  const giveUp = (v: Verdict) =>
    v.kind === 'mismatch'
      ? done(v.rowCount)
      : {
          pipelineText,
          note: v.kind === 'empty' ? { kind: 'empty' } : { kind: 'error', error: v.error },
        };

  for (let attempt = 0; ; attempt++) {
    onPhase('run');
    const mech = await verify(api, collection, arr, signal);
    transcript.push({ role: 'system', text: verdictLabel(mech) });
    if (mech.kind === 'unrun') return { pipelineText, note: { kind: 'unrun' } };

    let effective: Verdict = mech;
    if (mech.kind === 'ok') {
      onPhase('verify');
      transcript.push({ role: 'user', text: 'Review: do these results answer the request?' });
      const sem = await semanticVerify(
        agentApi,
        chatId,
        { request, pipelineText, rows: mech.rows },
        signal,
      );
      transcript.push({ role: 'assistant', text: sem.raw, reasoning: sem.reasoning });
      transcript.push({
        role: 'system',
        text: sem.ok
          ? 'Reviewed — the result answers the request ✓'
          : `Reviewed — needs refinement: ${sem.issue || 'does not fully answer the request'}`,
      });
      if (sem.ok) return done(mech.rowCount);
      effective = { kind: 'mismatch', issue: sem.issue, rowCount: mech.rowCount };
    }

    if (attempt >= MAX_CORRECTIONS) return giveUp(effective);

    onPhase('refine');
    transcript.push({ role: 'user', text: refineReason(effective) });
    const gf = await generate(
      agentApi,
      chatId,
      buildFixPrompt({ verdict: effective, samples }),
      signal,
    );
    transcript.push({ role: 'assistant', text: gf.raw, reasoning: gf.reasoning });
    const fixed = screen(gf.pipeline);
    if (fixed.block || fixed.pipelineText === pipelineText) return giveUp(effective);
    ({ pipelineText, arr } = fixed);
    refined = true;
  }
}

// A fresh run: the AI input field ALWAYS starts a new chat. Returns
// { pipelineText, note, transcript, chatId } — chatId lets the transcript modal
// continue this exact conversation later.
export async function runAgentQuery({
  api,
  agentApi,
  request,
  collection,
  fields = [],
  samples = null,
  currentPipeline = '',
  hints = {},
  onPhase = () => {},
  signal,
}: Omit<LoopArgs, 'chatId' | 'transcript' | 'onPhase'> & { onPhase?: (phase: string) => void }) {
  const transcript: Turn[] = [];
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal }); // prime read-only persona once
  const res = await runLoop({
    api,
    agentApi,
    chatId,
    request,
    collection,
    fields,
    samples,
    currentPipeline,
    hints,
    transcript,
    onPhase,
    signal,
  });
  return { ...res, transcript, chatId };
}

// Continue an EXISTING chat (from the transcript modal) — no new chat, no re-prime;
// the agent keeps the prior context. Appends to a copy of `transcript`. Returns
// { pipelineText, note, transcript, chatId }.
export async function continueAgentQuery({
  api,
  agentApi,
  chatId,
  request,
  collection,
  fields = [],
  samples = null,
  currentPipeline = '',
  hints = {},
  transcript = [],
  onPhase = () => {},
  signal,
}: Omit<LoopArgs, 'transcript' | 'onPhase'> & {
  transcript?: Turn[];
  onPhase?: (phase: string) => void;
}) {
  const t = [...transcript];
  const res = await runLoop({
    api,
    agentApi,
    chatId,
    request,
    collection,
    fields,
    samples,
    currentPipeline,
    hints,
    transcript: t,
    onPhase,
    signal,
  });
  return { ...res, transcript: t, chatId };
}
