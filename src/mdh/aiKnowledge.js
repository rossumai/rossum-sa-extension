// Internal Rossum / Master Data Hub knowledge that augments AI explanations.
//
// Each entry is matched against the AI input; matched hints are injected into
// the user prompt as expert hypotheses, not absolute facts. The system prompt
// asks the model to weave them in as "likely causes" alongside what it can
// infer from the raw input.
//
// Extending: add a new entry below. `match` may be a RegExp tested against
// the stringified input, or a function `(input, context, text) => boolean`.
// Phrase hints honestly ("most often", "in our experience") — the AI will
// echo the framing.

export const KNOWLEDGE = [
  {
    type: 'error',
    match: /operation was abandoned/i,
    hint:
      'In our experience, this is most often caused by the underlying ' +
      'Master Data Hub service pods restarting (during deployments, pod ' +
      'evictions, or health-check restarts). Retrying the operation usually ' +
      'works. Other transient infrastructure causes are possible.',
  },
];

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function findHints(input, type, context) {
  const text = typeof input === 'string' ? input : safeStringify(input);
  const out = [];
  for (const entry of KNOWLEDGE) {
    if (entry.type !== type && entry.type !== '*') continue;
    let matched = false;
    if (entry.match instanceof RegExp) {
      matched = entry.match.test(text);
    } else if (typeof entry.match === 'function') {
      try { matched = !!entry.match(input, context, text); } catch { matched = false; }
    }
    if (matched) out.push(entry.hint);
  }
  return out;
}
