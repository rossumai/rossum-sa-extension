// Deep-verify orchestration (spec §3): answer → fresh-chat critic → refine,
// capped. Pure: every side effect arrives injected (sendMainTurn/
// runCriticTurn/onPhase), so the loop is unit-testable end to end — the
// agentQuery.js precedent. The critic runs with NO shared context on purpose:
// same-chat "double-check" is self-agreement-biased prompt-following.

export const REVIEWER_MARKER = '[deep-verify reviewer]';

export type Verdict = { verdict: 'pass' | 'fail' | 'inconclusive'; issues: string[] };

export function parseVerdict(text: unknown): Verdict {
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*verdict:\s*(pass|fail)\b/i);
    if (!m) continue;
    if (m[1].toLowerCase() === 'pass') return { verdict: 'pass', issues: [] };
    const issues: string[] = [];
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

export function buildCriticPrompt(question: string, answer: string): string {
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

export function buildReviewerMessage(issues: string[]): string {
  return [
    `${REVIEWER_MARKER} An independent review of your last answer found these issues:`,
    ...issues.map((i) => `- ${i}`),
    'Please post a corrected answer.',
  ].join('\n');
}

// Returns null if any injected step reports abort/stale (null); otherwise the
// final verdict record. A critic THROW is "verification unavailable", not a
// loop failure — the answer stands, marked inconclusive (never auto-retried).
/** An answer turn. `verifiable: false` means the agent asked a question instead. */
export type MainTurn = { text: string; verifiable?: boolean };

export type DeepPhase = { phase: 'verify' | 'refine'; round: number };

export type DeepOutcome =
  | null                                   // a step reported abort/stale
  | { skipped: true }                      // nothing verifiable came back
  // `skipped?: false` makes this a discriminated union, so a caller can test `result.skipped`
  // on the outcome as a whole (which is how chat.js branches) rather than narrowing first.
  | (Verdict & { criticText: string | null; rounds: number; skipped?: false });

export async function runDeepTurn({ question, images, sendMainTurn, runCriticTurn, onPhase, maxRounds = 2 }: {
  question: string;
  images?: unknown[];
  sendMainTurn: (question: string, images?: unknown[]) => Promise<MainTurn | null>;
  runCriticTurn: (prompt: string) => Promise<string | null>;
  onPhase: (p: DeepPhase) => void;
  maxRounds?: number;
}): Promise<DeepOutcome> {
  let answer = await sendMainTurn(question, images);
  if (!answer) return null;
  if (answer.verifiable === false) return { skipped: true };

  for (let round = 0; ; round += 1) {
    onPhase({ phase: 'verify', round });
    let criticText: string | null;
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
    // A refine round can itself come back as a clarifying question (no answer
    // to verify) — skip like the first-answer case rather than badge it.
    if (answer.verifiable === false) return { skipped: true };
  }
}
