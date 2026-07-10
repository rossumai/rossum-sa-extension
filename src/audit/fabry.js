// src/audit/fabry.js
// Mr. Fabry over the Audit Logs app — one agent chat per session that answers
// questions about audit activity as a citation-free narrative. Pure prompt
// builders + injected-transport runners (agentApi injected), so the network
// stays out of unit tests. Mirrors src/inspector/synthesize.js.
import { newAcc, foldEvents, replyText } from '../mdh/agent/agentStream.js';

export const DEFAULT_QUESTION =
  "Summarize the latest activity in this organization's audit log: the most recent events, who did what, and anything notable.";

const FILTER_LABELS = [
  ['object_type', 'object type'], ['action', 'action'], ['object_id', 'object id'],
  ['username', 'username'], ['timestamp_after', 'after'], ['timestamp_before', 'before'],
];

function filterContext(filters) {
  const parts = [];
  for (const [key, label] of FILTER_LABELS) {
    const v = filters && filters[key];
    if (v != null && v !== '') parts.push(`${label}=${v}`);
  }
  return parts.length ? parts.join(', ') : '(no filters set)';
}

// Cap a seeded-mode row sample so a full page can't overflow the agent's
// content budget. Simple local cap (no promptBudget dependency).
const SEED_MAX_ROWS = 40;
const SEED_MAX_CHARS = 12000;
export function seedRows(rows) {
  const sample = (Array.isArray(rows) ? rows : []).slice(0, SEED_MAX_ROWS)
    .map((r) => { const { _idx, ...rest } = r || {}; return rest; });
  let json = JSON.stringify(sample);
  if (json.length > SEED_MAX_CHARS) json = json.slice(0, SEED_MAX_CHARS) + '…(truncated)';
  return json;
}

export function buildAuditPrompt({ question, filters, rows, mode }) {
  const head = [
    'You are Mr. Fabry answering a question in a READ-ONLY Rossum audit-log viewer. Never modify anything — only read and reason.',
    `The user is currently viewing audit logs filtered by: ${filterContext(filters)}.`,
  ];
  const body = mode === 'seeded'
    ? [
        'Here are the most recent audit-log entries currently loaded (JSON). Base your answer ONLY on these; do not claim anything beyond them, and say so if they are insufficient:',
        seedRows(rows),
      ]
    : [
        'Use your read-only tools to fetch the recent audit-log entries you need to answer. If you cannot retrieve audit logs, say so plainly rather than guessing.',
      ];
  const tail = [
    `Question: ${question}`,
    'Format your answer EXACTLY like this (plain text, no markdown headings, no JSON):',
    'Line 1: one punchy takeaway sentence (at most 12 words) — it doubles as a one-line preview.',
    'Then 3–6 bullet lines, each starting with "- ": one fact per bullet, most recent first.',
    'Last line: "Next step: …" naming the single most useful follow-up.',
    'Do NOT include any [e:…] citations — this viewer has no citation targets. Never invent activity that is not in the audit log.',
  ];
  return [...head, ...body, ...tail].join('\n\n');
}

export function buildFollowupPrompt(question) {
  return [
    'You are still answering questions in the same READ-ONLY Rossum audit-log viewer. Never modify anything — only read and reason.',
    'Answer ONLY from the audit-log entries already shared earlier in this conversation. If the answer is not in them, say so plainly — never invent.',
    'Answer concisely (short "- " bullets welcome), plain text, no markdown headings, no [e:…] citations.',
    `Question: ${question}`,
  ].join('\n\n');
}

async function streamTurn(agentApi, chatId, content, { onPhase = () => {}, onText = () => {}, signal }) {
  const acc = newAcc();
  let lastStatus = '';
  let lastText = '';
  await agentApi.streamMessage(chatId, content, {
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

export async function runAuditQuery({ agentApi, question, filters, rows, mode = 'autonomous', onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const res = await streamTurn(agentApi, chatId, buildAuditPrompt({ question, filters, rows, mode }), { onPhase, onText, signal });
  return { ...res, chatId };
}

export async function continueAuditQuery({ agentApi, chatId, question, onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  return streamTurn(agentApi, chatId, buildFollowupPrompt(question), { onPhase, onText, signal });
}
