// Escalation-gated agentic loop for the AI pipeline input. Generates ONE (exact)
// candidate, executes it, and escalates only on a real signal: a backend error,
// 0 rows, or a semantic verifier flagging the result. Corrections are a single
// progressive fix per round (minimal → rethink), ≤2 rounds, each seeing the full
// failure history. Returns { pipelineText, trace }; trace.calls is the ordered
// LLM-call timeline. Degrades to apply-best on any failure. `api` (llmChat,
// aggregate, find) is injected. Throws on AbortError and on a 403 from llmChat.
import {
  buildPipelineMessages, buildFixMessages, buildVerifyMessages, parseVerification,
  extractReply, stripFences, safeParseArray, verdictFor, samePipeline, ensureRowLimit,
  buildTrace,
} from './llmPipeline.js';

export const CANDIDATE_ANGLES = ['exact'];               // happy path: one candidate
export const CORRECTION_ANGLES = ['minimal', 'rethink']; // one per correction round (progressive)
export const MAX_ROUNDS = 3;                              // round 1 + up to 2 corrections
export const VERIFY_MIN_SCORE = 50;
const SAMPLE_ROWS = 3;
const VERDICT_RANK = { ok: 4, unrun: 3, empty: 2, error: 1, invalid: 0 };

const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// Generate one raw model output. Rethrows AbortError + 403; any other error → null.
async function genCandidate(api, messages, signal) {
  try {
    return stripFences(extractReply(await api.llmChat(messages, { signal })));
  } catch (e) {
    if (e?.name === 'AbortError' || e?.status === 403) throw e;
    return null;
  }
}

// Parse → cap → execute → mechanical verdict. Never throws except AbortError.
async function evalCandidate(api, collection, rawText, angle, signal) {
  const parsed = safeParseArray(rawText);
  if (!parsed) return { angle, raw: rawText, pipelineText: rawText ?? '', parsed: false, verdict: 'invalid', rowCount: 0 };
  const limited = ensureRowLimit(parsed);
  const pipelineText = limited === parsed ? rawText : JSON.stringify(limited, null, 2);
  if (!collection) return { angle, raw: rawText, pipelineText, parsed: true, verdict: 'unrun', rowCount: 0 };
  try {
    const res = await api.aggregate(collection, limited, { signal });
    const rows = res?.result || [];
    return { angle, raw: rawText, pipelineText, parsed: true, verdict: verdictFor({ ok: true, rowCount: rows.length }), rowCount: rows.length, sample: rows.slice(0, SAMPLE_ROWS) };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { angle, raw: rawText, pipelineText, parsed: true, verdict: 'error', rowCount: 0, error: e?.message || String(e) };
  }
}

function mechanicalBest(cands) {
  return [...cands].sort((a, b) => (VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]) || (b.rowCount - a.rowCount))[0];
}

// Verify ≥1 candidates' RESULTS. On a parse-failure, retry ONCE with a compact
// prompt (llmchat is deterministic, so an identical retry would re-truncate).
// Returns { chosen, verification, parsed, ms }.
async function verifyAndSelect(api, ctx, cands, signal, onPhase) {
  onPhase('Checking the result');
  let verification = null;
  const t0 = clock();
  try {
    for (const compact of [false, true]) {           // attempt 1 normal; attempt 2 compact (only if needed)
      const msgs = buildVerifyMessages({ request: ctx.request, collection: ctx.collection, fields: ctx.fields, candidates: cands, compact });
      verification = parseVerification(stripFences(extractReply(await api.llmChat(msgs, { signal }))));
      if (verification) break;
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    verification = null;
  }
  const ms = clock() - t0;
  if (verification) {
    for (const j of verification.candidates || []) {
      const c = cands[(j.index || 0) - 1];
      if (c) { c.answersRequest = j.answersRequest; c.score = j.score; c.issue = j.issue || undefined; }
    }
    const best = (Number.isInteger(verification.best) && cands[verification.best - 1]) || cands[0];
    return { chosen: best, verification, parsed: true, ms };
  }
  return { chosen: cands.length > 1 ? mechanicalBest(cands) : cands[0], verification: null, parsed: false, ms };
}

function isGood(c, verification) {
  if (c.verdict !== 'ok') return false;
  if (!verification) return true; // can't judge → accept a running result
  return c.answersRequest !== false && (typeof c.score !== 'number' || c.score >= VERIFY_MIN_SCORE);
}

// Human reason a candidate failed — carried into the next retry's history.
function failReason(c) {
  const reviewer = c.issue ? ` Reviewer: ${c.issue}.` : '';
  if (c.verdict === 'error') return `failed with error: ${c.error || 'unknown error'}.${reviewer}`;
  if (c.verdict === 'empty') return `executed but returned 0 matching documents (likely a value-format or structure mismatch).${reviewer}`;
  if (c.verdict === 'invalid') return `was not a valid pipeline.${reviewer}`;
  return `executed but did not correctly answer the request.${reviewer}`;
}

function alreadyTried(tried, rawText) {
  return tried.some((t) => samePipeline(t.raw, rawText));
}

async function findSamples(api, collection) {
  try { return (await api.find(collection, { limit: 3 }))?.result || null; } catch { return null; }
}

export async function runAiPipeline({ api, request, fields = [], collection, currentPipeline = '',
  samples = null, knownValues = null, numericStringFields = null, searchIndexes = null,
  fieldTypes = null, ranges = null, arrayPaths = null, topValues = null,
  signal, onPhase = () => {} }) {

  const seedSamples = Array.isArray(samples) && samples.length ? samples.slice(0, 3) : null;
  const hints = { knownValues, numericStringFields, searchIndexes, fieldTypes, ranges, arrayPaths, topValues };
  const traceHints = { ...hints, collection, fieldCount: (fields || []).length };
  const ctx = { request, collection, fields };

  const calls = [];
  let seq = 0, groupSeq = 0;
  const nextGroup = () => `g${groupSeq++}`;
  const recordVerify = (sel, round, chosen) => calls.push({
    seq: seq++, kind: 'verify', round,
    status: sel.parsed ? (isGood(chosen, sel.verification) ? 'passed' : 'flagged') : 'parse-fail',
    durationMs: sel.ms, group: nextGroup(),
  });

  // Round 1 — single exact candidate.
  onPhase('Generating the query');
  const t0 = clock();
  const raw0 = await genCandidate(api, buildPipelineMessages({ fields, currentPipeline, request, samples: seedSamples, collection, angle: CANDIDATE_ANGLES[0], ...hints }), signal);
  const genMs = clock() - t0;
  const grp0 = nextGroup();
  if (raw0 == null) {
    calls.push({ seq: seq++, kind: 'generate', round: 1, angle: CANDIDATE_ANGLES[0], status: 'failed', durationMs: genMs, group: grp0 });
    return { pipelineText: '', trace: buildTrace({ request, rounds: [{ kind: 'initial', candidates: [], picked: null }], chosen: null, hints: traceHints, calls }) };
  }
  onPhase('Running the query');
  const c0 = await evalCandidate(api, collection, raw0, CANDIDATE_ANGLES[0], signal);
  calls.push({ seq: seq++, kind: 'generate', round: 1, angle: c0.angle, status: c0.verdict, durationMs: genMs, group: grp0 });

  if (!c0.parsed) { // not a pipeline → apply raw as-is (today's behavior)
    const rounds = [{ kind: 'initial', candidates: [c0], picked: null }];
    return { pipelineText: raw0, trace: buildTrace({ request, rounds, chosen: null, hints: traceHints, calls }) };
  }
  if (!collection) { // can't execute/verify → apply capped (today's behavior)
    const rounds = [{ kind: 'initial', candidates: [c0], picked: c0 }];
    return { pipelineText: c0.pipelineText, trace: buildTrace({ request, rounds, chosen: c0, hints: traceHints, calls }) };
  }

  let chosen = c0;
  let verification = null;
  const rounds = [{ kind: 'initial', candidates: [c0], picked: c0 }];

  // Verify only when the candidate ran ok; error/empty escalate without a verify call.
  if (c0.verdict === 'ok') {
    const sel = await verifyAndSelect(api, ctx, [c0], signal, onPhase);
    chosen = sel.chosen; verification = sel.verification;
    rounds[0].verification = verification;
    recordVerify(sel, 1, chosen);
  }

  const tried = [];
  const recordFailed = (c) => { if (c && c.raw != null && !alreadyTried(tried, c.raw)) tried.push({ raw: c.raw, pipelineText: c.pipelineText, reason: failReason(c) }); };

  for (let round = 2; round <= MAX_ROUNDS && !isGood(chosen, verification); round++) {
    if (round === 2) recordFailed(chosen);
    const angle = CORRECTION_ANGLES[round - 2] || CORRECTION_ANGLES[CORRECTION_ANGLES.length - 1];
    const trigger = chosen.verdict === 'error' ? 'error' : chosen.verdict === 'empty' ? 'empty' : 'mismatch';
    onPhase(`Refining (${round - 1} of ${MAX_ROUNDS - 1})`);
    const fixSamples = chosen.verdict === 'empty' ? (seedSamples || await findSamples(api, collection)) : null;

    const tf = clock();
    const fixRaw = await genCandidate(api, buildFixMessages({ fields, request, attempts: tried, angle, samples: fixSamples, collection, ...hints }), signal);
    const fixMs = clock() - tf;
    const grpF = nextGroup();
    if (fixRaw == null || alreadyTried(tried, fixRaw)) {
      calls.push({ seq: seq++, kind: 'fix', round, angle, status: fixRaw == null ? 'failed' : 'duplicate', durationMs: fixMs, group: grpF });
      break; // no progress (failed generation or duplicate)
    }
    onPhase('Running the correction');
    const fix = await evalCandidate(api, collection, fixRaw, angle, signal);
    calls.push({ seq: seq++, kind: 'fix', round, angle, status: fix.parsed ? fix.verdict : 'invalid', durationMs: fixMs, group: grpF });
    if (!fix.parsed) break;

    const cands = [chosen, fix];
    const sel = await verifyAndSelect(api, ctx, cands, signal, onPhase);
    const prevChosen = chosen;
    verification = sel.verification;
    chosen = sel.chosen;
    rounds.push({ kind: 'correction', trigger, candidates: cands, verification, picked: chosen });
    recordVerify(sel, round, chosen);
    recordFailed(fix);
    recordFailed(prevChosen);
  }

  const corrected = rounds.some((r) => r.kind === 'correction');
  return { pipelineText: chosen.pipelineText, trace: buildTrace({ request, rounds, chosen, verification, hints: traceHints, corrected, calls }) };
}
