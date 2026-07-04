// Narrative synthesis over the evidence model — one agent chat per annotation.
// The prompt seeds the FULL evidence list (facts we already hold, budget-capped);
// the agent may use its read-only tools for residual gaps, but every claim should
// cite an evidence id we can resolve. Pure prompt/parse here; transport injected.
import { budgetedJoin } from './promptBudget.js';
import { newAcc, foldEvents, replyText } from '../mdh/agent/agentStream.js';

function itemLine(it) {
  return `[${it.id}] (${it.reliability}) ${it.fact}${it.culprit ? ` — culprit: ${it.culprit.kind} ${it.culprit.name}${it.culprit.id != null ? ` #${it.culprit.id}` : ''}` : ''}`;
}

export function buildSynthesisPrompt(evidence, annotation = {}) {
  const v = evidence?.verdict || {};
  const head = [
    'You are writing the diagnosis for a single Rossum annotation in a READ-ONLY forensic tool. Never modify anything — only read and reason.',
    `Annotation: id ${annotation.id}, status ${annotation.status}${annotation.queueId ? `, queue ${annotation.queueId}` : ''}.`,
    `Programmatic verdict (already verified): ${v.headline || 'unknown'}.`,
    'Evidence collected so far (id, reliability, fact):',
  ];
  const middle = (evidence?.items || []).map(itemLine);
  const tail = [
    'Format your diagnosis EXACTLY like this (plain text, no markdown headings, no JSON, no nested bullets):',
    'Line 1: one short takeaway sentence.',
    'Then 3–6 bullet lines, each starting with "- ": one fact per bullet, in story order (arrival, extraction, what stopped or advanced it).',
    'Last line: "Next step: …" naming the single most useful action.',
    '- After EVERY factual claim, cite the supporting evidence id inline as [e:<id>] — e.g. [e:blocker:0]. Copy ids exactly.',
    '- For anything marked (unavailable), say plainly that it is not recorded — never invent a cause.',
    '- You may use your read-only tools to check details the evidence lacks, but do not repeat the whole evidence list back.',
  ];
  return budgetedJoin(head, middle, tail);
}

const CITE_RE = /\[e:([A-Za-z0-9_.:-]+)\]/g;

export function parseCitations(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out = [];
  let last = 0;
  for (const m of s.matchAll(CITE_RE)) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'cite', id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

// Line-aware view over the streamed narrative: paragraph and bullet blocks,
// each with its citation segments. Streaming-safe (a partial last line renders).
export function parseNarrative(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const blocks = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^[-•]\s+(.*)$/.exec(t);
    blocks.push(m ? { type: 'li', segments: parseCitations(m[1]) } : { type: 'p', segments: parseCitations(t) });
  }
  return blocks;
}

export async function runSynthesis({ agentApi, evidence, annotation, onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const acc = newAcc();
  let lastStatus = 'thinking';
  let lastText = '';
  await agentApi.streamMessage(chatId, buildSynthesisPrompt(evidence, annotation), {
    signal,
    onEvent: (ev) => {
      foldEvents(acc, [ev]);
      if (acc.status && acc.status !== lastStatus) { lastStatus = acc.status; onPhase(acc.status); }
      const t = replyText(acc);
      if (t !== lastText) { lastText = t; onText(t); }
    },
  });
  return { text: replyText(acc), reasoning: acc.reasoning, tools: acc.tools.slice(), chatId };
}

// Follow-up question in the SAME synthesis chat (context intact, no re-prime) —
// the "continue the conversation" affordance, mirroring MDH's continueAgentQuery.
export function buildFollowupPrompt(question) {
  return [
    'You are still investigating the same annotation in the same READ-ONLY forensic tool. Never modify anything — only read and reason (your read-only tools are available).',
    'Answer the question concisely (short bullets welcome). Cite evidence ids inline as [e:<id>] where they support a claim; if something is not recorded, say so plainly — never invent.',
    `Question: ${question}`,
  ].join('\n\n');
}

export async function continueSynthesis({ agentApi, chatId, question, onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  const acc = newAcc();
  let lastStatus = 'thinking';
  let lastText = '';
  await agentApi.streamMessage(chatId, buildFollowupPrompt(question), {
    signal,
    onEvent: (ev) => {
      foldEvents(acc, [ev]);
      if (acc.status && acc.status !== lastStatus) { lastStatus = acc.status; onPhase(acc.status); }
      const t = replyText(acc);
      if (t !== lastText) { lastText = t; onText(t); }
    },
  });
  return { text: replyText(acc), reasoning: acc.reasoning, tools: acc.tools.slice() };
}
