// Agentic self-correcting loop for the AI pipeline input.
// Generates a pipeline, executes it against the collection, and iterates on
// failure: backend errors and 0-row ("suspect") results are fed back to llmchat
// as a fresh one-shot user message until the pipeline works or a guardrail stops
// it. Live-verified on a customer dev org 2026-06-23 (fixes CA/California; doesn't
// thrash on a legitimately-empty query).
//
// `api` is injected (api.llmChat, api.aggregate, api.find) so the loop is unit-
// testable without a network. Returns { pipelineText } — the caller applies it
// to the editor; the query and its normal execution are the only feedback.
// Throws on AbortError.
import {
  buildPipelineMessages, buildFixMessages, extractReply, stripFences,
  safeParseArray, verdictFor, samePipeline, ensureRowLimit,
} from './llmPipeline.js';

export const MAX_AI_ATTEMPTS = 3; // 1 generate + up to 2 corrections

// Returns { pipelineText }. No status notices — the applied pipeline and its
// normal execution are the feedback. The loop self-corrects silently: it always
// applies the best pipeline it reached (working if it found one; otherwise the
// last attempt, whose error/0-rows the user sees on running it).
export async function runAiPipeline({ api, request, fields, collection, currentPipeline, samples = null, knownValues = null, numericStringFields = null, searchIndexes = null, signal, onPhase = () => {} }) {
  const seedSamples = Array.isArray(samples) && samples.length > 0 ? samples.slice(0, 3) : null;
  const hints = { knownValues, numericStringFields, searchIndexes };
  onPhase('generating');
  let pipelineText = stripFences(extractReply(
    await api.llmChat(buildPipelineMessages({ fields, currentPipeline, request, samples: seedSamples, ...hints }), { signal }),
  ));

  let triedEmpty = false;

  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    // `pipelineText` is the model's RAW output (used for fix-context and the
    // no-progress comparison). `appliedText` is what we run/return — the same
    // pipeline with a guaranteed ≤50-row cap.
    const parsed = safeParseArray(pipelineText);
    if (!parsed) return { pipelineText }; // not a pipeline array → apply as-is

    // Guarantee a ≤50-row cap (the model is instructed to add one; this enforces
    // it for the no-limit / empty-pipeline case). Keeps execution fast — measured
    // sub-second even on a full-scan $group, vs 3.5s+ unbounded.
    const limited = ensureRowLimit(parsed);
    const appliedText = limited === parsed ? pipelineText : JSON.stringify(limited, null, 2);

    if (!collection) return { pipelineText: appliedText }; // can't verify → apply capped

    onPhase('checking');
    let verdict;
    let errMsg = '';
    try {
      const res = await api.aggregate(collection, limited, { signal });
      verdict = verdictFor({ ok: true, rowCount: (res?.result || []).length });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      verdict = 'error';
      errMsg = e?.message || String(e);
    }

    if (verdict === 'ok') return { pipelineText: appliedText };
    // Out of attempts → apply the best (last) pipeline; its execution is the feedback.
    if (attempt === MAX_AI_ATTEMPTS) return { pipelineText: appliedText };

    let fixSamples = null;
    if (verdict === 'empty') {
      if (triedEmpty) return { pipelineText: appliedText };
      triedEmpty = true;
      // Prefer the in-memory seed samples; only hit the network if none were passed.
      if (seedSamples) {
        fixSamples = seedSamples;
      } else {
        onPhase('inspecting');
        try { fixSamples = (await api.find(collection, { limit: 3 }))?.result || null; } catch { /* best effort */ }
      }
    }

    onPhase('fixing');
    const fixMsgs = buildFixMessages({
      fields, request, previousPipeline: appliedText,
      problem: verdict === 'error' ? { type: 'error', message: errMsg } : { type: 'empty' },
      samples: fixSamples, ...hints,
    });
    const next = stripFences(extractReply(await api.llmChat(fixMsgs, { signal })));

    // No progress (compare RAW model outputs) → stop and apply the capped pipeline.
    if (samePipeline(next, pipelineText)) return { pipelineText: appliedText };
    pipelineText = next;
  }

  return { pipelineText };
}
