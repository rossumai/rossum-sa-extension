// Deep-verify orchestration (spec §3): answer → fresh-chat critic → refine,
// capped. Pure: every side effect arrives injected (sendMainTurn/
// runCriticTurn/onPhase), so the loop is unit-testable end to end — the
// agentQuery.js precedent. The critic runs with NO shared context on purpose:
// same-chat "double-check" is self-agreement-biased prompt-following.

export const REVIEWER_MARKER = '[deep-verify reviewer]';

export function parseVerdict(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*verdict:\s*(pass|fail)\b/i);
    if (!m) continue;
    if (m[1].toLowerCase() === 'pass') return { verdict: 'pass', issues: [] };
    const issues = [];
    for (const l of lines.slice(i + 1)) {
      const b = l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)/);
      if (b) issues.push(b[1]);
    }
    // A FAIL with no actionable bullets is not a usable verdict — call it
    // inconclusive rather than showing "0 unresolved issues" and burning
    // refine rounds on an empty critique.
    if (!issues.length) return { verdict: 'inconclusive', issues: [] };
    return { verdict: 'fail', issues };
  }
  return { verdict: 'inconclusive', issues: [] };
}

export function buildCriticPrompt(question, answer) {
  return [
    'You are an independent reviewer. Another assistant answered a question about this Rossum organization.',
    'Adversarially verify every factual claim in the answer USING YOUR TOOLS against the live organization. Stay strictly read-only.',
    'Reply with a first line of exactly "VERDICT: PASS" (all claims hold) or "VERDICT: FAIL", and on FAIL list each concrete problem as a "- " bullet.',
    '',
    `QUESTION:\n${question}`,
    '',
    `ANSWER UNDER REVIEW:\n${answer}`,
  ].join('\n');
}

export function buildReviewerMessage(issues) {
  return [
    `${REVIEWER_MARKER} An independent review of your last answer found these issues:`,
    ...issues.map((i) => `- ${i}`),
    'Please post a corrected answer.',
  ].join('\n');
}

// Returns null if any injected step reports abort/stale (null); otherwise the
// final verdict record. A critic THROW is "verification unavailable", not a
// loop failure — the answer stands, marked inconclusive (never auto-retried).
export async function runDeepTurn({ question, images, sendMainTurn, runCriticTurn, onPhase, maxRounds = 2 }) {
  let answer = await sendMainTurn(question, images);
  if (!answer) return null;

  for (let round = 0; ; round += 1) {
    onPhase({ phase: 'verify', round });
    let criticText;
    try {
      criticText = await runCriticTurn(buildCriticPrompt(question, answer.text));
    } catch {
      return { verdict: 'inconclusive', issues: [], criticText: null, rounds: round };
    }
    if (criticText == null) return null;

    const { verdict, issues } = parseVerdict(criticText);
    if (verdict !== 'fail') return { verdict, issues, criticText, rounds: round };
    if (round >= maxRounds) return { verdict: 'fail', issues, criticText, rounds: round };

    onPhase({ phase: 'refine', round: round + 1 });
    answer = await sendMainTurn(buildReviewerMessage(issues));
    if (!answer) return null;
  }
}
