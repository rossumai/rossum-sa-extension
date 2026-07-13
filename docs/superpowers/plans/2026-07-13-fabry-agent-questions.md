# Fabry Agent Interactive Elements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the agent's clarifying questions (`data-agent-question`) as an inline interactive form the user can answer, and never render a blank turn — degrade every unknown interactive element and stream error to a clear, named notice.

**Architecture:** Fold the new events in the pure stream layer (`agentStream.js`), carry them onto the assistant turn (`chat.js accTurn`), render them in `AssistantTurn` via two small new components (`FabryQuestions`, `FabryNotice`); answers go back as one normal message; deep verify skips question turns. Spec: `docs/superpowers/specs/2026-07-13-fabry-agent-questions-design.md`.

**Tech Stack:** Preact + signals, existing `src/agent/` transport, vitest/jsdom. **No new dependencies.**

## Global Constraints

- **No git commits during execution** (owner rule) — each task's gate is its green test run; the owner commits at the end as ONE commit.
- Tests in `tests/*.test.js`, `h()` convention (no raw JSX); `// @vitest-environment jsdom` where DOM is used; Preact state is microtask-deferred — component tests that assert post-event DOM use the file-local `flush()` helper (`() => new Promise((r) => setTimeout(r, 0))`); a component test whose behavior lives in a `useEffect` also needs the immediate-rAF override (see `tests/ui-fabry-mermaid.test.js`) — not needed here (no effects in the new components).
- JSX gotcha: no `\uXXXX` in JSX text/attributes — use `{'…'}` expressions or literal glyphs.
- No customer names/data anywhere; no chat/question/verification content persisted client-side (questions are not persisted server-side either — verified).
- Reviewer marker string stays exactly `[deep-verify reviewer]`; blue scheme tokens for all new CSS (`--accent`, `--info-*`, `--warning-*`, `--danger-*`); new classes `.fabry-q-*`, `.fabry-notice*`.
- Event shape (verified live): `{type:'data-agent-question', data:{questions:[{question, options:[], multi_select}]}}`; answering = a plain next message to the same chat; questions are NOT persisted.
- Full suite green after every task (`npm test`); final task runs `npm run build` (loaded extension runs `dist/`).

---

### Task 1: Stream fold — questions, unknown `data-*`, errors, `fallbackNotice`, tool labels

**Files:**
- Modify: `src/agent/agentStream.js`
- Test: `tests/agent-stream.test.js`

**Interfaces:**
- Consumes: existing `replyText`, `newAcc`, `foldEvents`.
- Produces:
  - `newAcc()` gains `questions: null`, `unhandled: []`, `error: null`.
  - `foldEvents` handles `data-agent-question` → `acc.questions`; `error`/`tool-output-error` → `acc.error`; any other `data-*` type → dedup-push `{type, data}` into `acc.unhandled`.
  - `fallbackNotice(turn)` → `null | {kind:'error', text} | {kind:'unsupported', types:string[], payloads} | {kind:'empty'}` where `turn` is any object with `{text, questions, error, unhandled}`.
  - Extended `TOOL_LABELS`.

- [ ] **Step 1: Write the failing tests** (append to `tests/agent-stream.test.js`)

```js
import { newAcc, foldEvents, fallbackNotice } from '../src/agent/agentStream.js';

describe('foldEvents — interactive elements', () => {
  it('captures data-agent-question into acc.questions', () => {
    const acc = newAcc();
    foldEvents(acc, [{ type: 'data-agent-question', data: { questions: [{ question: 'Name?', options: [], multi_select: false }] } }]);
    expect(acc.questions).toEqual([{ question: 'Name?', options: [], multi_select: false }]);
  });
  it('captures unknown data-* into acc.unhandled (deduped by type), leaves known data-* alone', () => {
    const acc = newAcc();
    foldEvents(acc, [
      { type: 'data-agent-confirmation', data: { prompt: 'ok?' } },
      { type: 'data-agent-confirmation', data: { prompt: 'again' } },
      { type: 'data-final-answer', data: { text: 'x' } },
    ]);
    expect(acc.unhandled.map((u) => u.type)).toEqual(['data-agent-confirmation']);
    expect(acc.finalAnswer).toBe('x'); // known data-* still handled, not in unhandled
  });
  it('captures error and tool-output-error into acc.error', () => {
    const acc = newAcc();
    foldEvents(acc, [{ type: 'error', errorText: 'boom' }]);
    expect(acc.error).toBe('boom');
    const acc2 = newAcc();
    foldEvents(acc2, [{ type: 'tool-output-error', errorText: 'tool failed' }]);
    expect(acc2.error).toBe('tool failed');
  });
});

describe('fallbackNotice', () => {
  it('null when text or questions present', () => {
    expect(fallbackNotice({ text: 'hi' })).toBeNull();
    expect(fallbackNotice({ text: '', questions: [{ question: 'q' }] })).toBeNull();
  });
  it('error > unsupported > empty priority', () => {
    expect(fallbackNotice({ text: '', error: 'boom' })).toEqual({ kind: 'error', text: 'boom' });
    expect(fallbackNotice({ text: '', unhandled: [{ type: 'data-x', data: 1 }] }))
      .toEqual({ kind: 'unsupported', types: ['data-x'], payloads: [{ type: 'data-x', data: 1 }] });
    expect(fallbackNotice({ text: '' })).toEqual({ kind: 'empty' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/agent-stream.test.js`
Expected: FAIL — `fallbackNotice` is not exported; `acc.questions/unhandled/error` undefined.

- [ ] **Step 3: Implement** (`src/agent/agentStream.js`)

Extend `newAcc`:

```js
export function newAcc() {
  return { reasoning: '', text: '', finalAnswer: null, status: '', done: false, tools: [], questions: null, unhandled: [], error: null };
}
```

Replace the `foldEvents` switch body's `default` and add the new cases:

```js
export function foldEvents(acc, events) {
  for (const e of events) {
    switch (e && e.type) {
      case 'reasoning-start': acc.status = 'thinking'; break;
      case 'reasoning-delta': acc.reasoning += e.delta || ''; break;
      case 'text-delta': acc.text += e.delta || ''; break;
      case 'data-final-answer': acc.finalAnswer = e.data?.text ?? acc.finalAnswer; break;
      case 'data-agent-question': acc.questions = e.data?.questions || acc.questions; break;
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
        if (typeof e?.type === 'string' && e.type.startsWith('data-') && !acc.unhandled.some((u) => u.type === e.type)) {
          acc.unhandled.push({ type: e.type, data: e.data });
        }
        break;
    }
  }
  return acc;
}
```

Add after `replyText`:

```js
// Decide what a FINISHED turn shows when it has nothing normally renderable.
// null → the turn has text and/or questions; render those. Otherwise a notice,
// in priority order: stream error, then an unsupported interactive element
// (named, with raw payload), then a quiet empty note. Never render blank.
export function fallbackNotice(turn) {
  if ((turn.text && turn.text.length) || turn.questions) return null;
  if (turn.error) return { kind: 'error', text: turn.error };
  if (turn.unhandled && turn.unhandled.length) {
    return { kind: 'unsupported', types: turn.unhandled.map((u) => u.type), payloads: turn.unhandled };
  }
  return { kind: 'empty' };
}
```

Extend `TOOL_LABELS` (add these keys to the existing object):

```js
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agent-stream.test.js` → pass. `npm test` → green (existing stream/agent tests unaffected: new acc fields are additive; folding an event with no `data-*`/error/question is unchanged).

---

### Task 2: `deepLoop` — verifiable flag + skip-question sentinel

**Files:**
- Modify: `src/fabry/deepLoop.js`
- Test: `tests/fabry-deeploop.test.js`

**Interfaces:**
- Consumes: injected `sendMainTurn(content, images?)` now returns `{text, verifiable} | null`.
- Produces: `runDeepTurn` returns `{skipped: true}` when the FIRST main answer has `verifiable === false`; unchanged otherwise (`null` on abort; `{verdict, issues, criticText, rounds}` on completion).

- [ ] **Step 1: Write the failing test** (append to the `runDeepTurn` describe in `tests/fabry-deeploop.test.js`)

```js
  it('skips verification when the first answer is a question turn', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: '', verifiable: false });
    const runCriticTurn = vi.fn();
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} });
    expect(out).toEqual({ skipped: true });
    expect(runCriticTurn).not.toHaveBeenCalled();
  });
  it('still verifies a normal answer that omits the verifiable flag (back-compat)', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer' });
    const runCriticTurn = vi.fn().mockResolvedValue('VERDICT: PASS');
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} });
    expect(out.verdict).toBe('pass');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-deeploop.test.js`
Expected: FAIL — first new test gets a critic call / non-`{skipped}` result.

- [ ] **Step 3: Implement** — in `runDeepTurn`, after the first-answer guard:

```js
export async function runDeepTurn({ question, images, sendMainTurn, runCriticTurn, onPhase, maxRounds = 2 }) {
  let answer = await sendMainTurn(question, images);
  if (!answer) return null;
  if (answer.verifiable === false) return { skipped: true }; // a question turn — nothing to verify
  // ...rest unchanged...
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-deeploop.test.js` → pass. `npm test` → green.

---

### Task 3: `chat.js` — carry fields onto the turn, verifiable, skip handling, `answerQuestions`

**Files:**
- Modify: `src/fabry/chat.js`
- Test: `tests/fabry-chat.test.js`

**Interfaces:**
- Consumes: Task 1 acc fields; Task 2 `{skipped}`.
- Produces: `accTurn` carries `questions/unhandled/error`; deep-path `sendMainTurn` returns `{text, verifiable}`; `{skipped}` attaches no verdict and returns success; new `formatAnswers(answers)` + `answerQuestions(answers)`.

- [ ] **Step 1: Write the failing tests** (append to `tests/fabry-chat.test.js`)

```js
import { formatAnswers } from '../src/fabry/chat.js'; // add to the existing import line

describe('formatAnswers', () => {
  it('one question → bare answer', () => {
    expect(formatAnswers([{ question: 'Name?', answer: 'Acme' }])).toBe('Acme');
  });
  it('multiple → numbered question → answer', () => {
    expect(formatAnswers([{ question: 'Name?', answer: 'Acme' }, { question: 'Scope?', answer: 'All queues' }]))
      .toBe('1. Name?\n   → Acme\n2. Scope?\n   → All queues');
  });
});

describe('question turns', () => {
  function streamQuestion() {
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      onEvent({ type: 'data-agent-question', data: { questions: [{ question: 'Name?', options: [], multi_select: false }] } });
      onEvent({ type: 'finish' });
    });
  }
  beforeEach(() => { store.personaChoice.value = 'default'; store.activeChatId.value = 'chat_main'; });

  it('non-deep: pushes an assistant turn carrying questions, no text', async () => {
    store.deepMode.value = false;
    streamQuestion();
    const ok = await sendMessage('draft an email', []);
    expect(ok).toBe(true);
    const last = store.thread.value.at(-1);
    expect(last.role).toBe('assistant');
    expect(last.questions).toEqual([{ question: 'Name?', options: [], multi_select: false }]);
    expect(last.text).toBe('');
  });

  it('deep mode: a question turn is NOT verified (no verdict, no critic chat)', async () => {
    store.deepMode.value = true; store.deepVerifyAllowed.value = true;
    streamQuestion();
    const ok = await sendMessage('draft an email', []);
    expect(ok).toBe(true);
    expect(agentApi.createChat).not.toHaveBeenCalled(); // no critic chat
    expect(store.thread.value.at(-1).deep).toBeUndefined();
  });

  it('answerQuestions sends the formatted answer as a normal message', async () => {
    store.deepMode.value = false;
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => { onEvent({ type: 'text-delta', delta: 'ok' }); onEvent({ type: 'finish' }); });
    await answerQuestions([{ question: 'Name?', answer: 'Acme' }]);
    expect(agentApi.streamMessage.mock.calls.at(-1)[1]).toBe('Acme');
  });
});
```

(Add `answerQuestions` and `formatAnswers` to the file's existing `import { … } from '../src/fabry/chat.js'`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-chat.test.js`
Expected: FAIL — `formatAnswers`/`answerQuestions` undefined; turn lacks `questions`.

- [ ] **Step 3: Implement** (`src/fabry/chat.js`)

`BLANK_TURN` gains the three fields:

```js
const BLANK_TURN = { chip: false, command: false, images: [], feedback: null, reasoning: '', tools: [], interrupted: false, questions: null, unhandled: null, error: null };
```

`accTurn` carries them:

```js
function accTurn(acc, interrupted) {
  return {
    ...BLANK_TURN, role: 'assistant', text: replyText(acc), reasoning: acc.reasoning, tools: acc.tools, interrupted,
    questions: acc.questions || null,
    unhandled: (acc.unhandled && acc.unhandled.length) ? acc.unhandled : null,
    error: acc.error || null,
  };
}
```

Deep-path `sendMainTurn` return line — add `verifiable`:

```js
          pushTurn(accTurn(acc, false));
          store.liveTurn.value = null;
          return { text: replyText(acc), verifiable: !acc.questions };
```

Deep-path result handling — honor `{skipped}` (replace the `if (!result) return false;` + verdict-attach block):

```js
      if (id !== loadId) return false;
      if (!result) return false; // aborted/stale mid-loop
      if (!result.skipped) {
        // Attach the verdict to the last assistant turn.
        const turns = store.thread.value;
        for (let i = turns.length - 1; i >= 0; i -= 1) {
          if (turns[i].role === 'assistant') {
            store.thread.value = turns.map((t, j) => (j === i ? { ...t, deep: { verdict: result.verdict, issues: result.issues, criticText: result.criticText } } : t));
            break;
          }
        }
      }
```

Add near `sendMessage` (both exported):

```js
// Format the user's answers to an agent clarifying-question turn into ONE
// message. One question → the bare answer; several → numbered so the agent
// maps answer to question unambiguously.
export function formatAnswers(answers) {
  if (answers.length === 1) return answers[0].answer;
  return answers.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`).join('\n');
}

// Send the answers to an agent question as the next message in the same chat
// (verified: a plain message is the answer; the agent continues). Routes
// through sendMessage so it streams, refreshes the sidebar, and — if deep mode
// is on — the answer's turn verifies normally.
export function answerQuestions(answers) {
  return sendMessage(formatAnswers(answers));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-chat.test.js tests/fabry-deeploop.test.js` → pass. `npm test` → green.

---

### Task 4: `FabryQuestions` component

**Files:**
- Create: `src/fabry/components/FabryQuestions.jsx`
- Test: `tests/fabry-questions.test.js`

**Interfaces:**
- Produces: `FabryQuestions({ questions, onSubmit })` — `onSubmit(answers)` where `answers = [{question, answer}]` (multi-select answers joined with ", "). Free-text → text input; single-select → option buttons; multi-select → checkboxes (rendered as toggle buttons). Owns local answer + submitted state; after submit renders chosen answers read-only.

- [ ] **Step 1: Write the failing tests** (`tests/fabry-questions.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import FabryQuestions from '../src/fabry/components/FabryQuestions.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(FabryQuestions, props), root);
  return root;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FabryQuestions', () => {
  it('free-text: submit disabled until filled, emits {question, answer}', async () => {
    const onSubmit = vi.fn();
    const root = mount({ questions: [{ question: 'Name?', options: [], multi_select: false }], onSubmit });
    const submit = root.querySelector('.fabry-q-submit');
    expect(submit.disabled).toBe(true);
    const input = root.querySelector('.fabry-q-input');
    input.value = 'Acme'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(root.querySelector('.fabry-q-submit').disabled).toBe(false);
    root.querySelector('.fabry-q-submit').click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Name?', answer: 'Acme' }]);
  });

  it('single-select: clicking an option enables submit and emits it', async () => {
    const onSubmit = vi.fn();
    const root = mount({ questions: [{ question: 'Env?', options: ['dev', 'prod'], multi_select: false }], onSubmit });
    root.querySelectorAll('.fabry-q-opt')[1].click();
    await flush();
    root.querySelector('.fabry-q-submit').click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Env?', answer: 'prod' }]);
  });

  it('multi-select: toggles multiple, joined with comma', async () => {
    const onSubmit = vi.fn();
    const root = mount({ questions: [{ question: 'Which?', options: ['a', 'b', 'c'], multi_select: true }], onSubmit });
    const opts = root.querySelectorAll('.fabry-q-opt');
    opts[0].click(); opts[2].click();
    await flush();
    root.querySelector('.fabry-q-submit').click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Which?', answer: 'a, c' }]);
  });

  it('after submit, renders chosen answers read-only (no inputs)', async () => {
    const root = mount({ questions: [{ question: 'Name?', options: [], multi_select: false }], onSubmit: vi.fn() });
    const input = root.querySelector('.fabry-q-input');
    input.value = 'Acme'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    root.querySelector('.fabry-q-submit').click();
    await flush();
    expect(root.querySelector('.fabry-q-input')).toBeNull();
    expect(root.querySelector('.fabry-q-answer').textContent).toBe('Acme');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-questions.test.js`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement** (`src/fabry/components/FabryQuestions.jsx`)

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';

// Inline interactive form for one turn's agent clarifying questions. Free-text
// → input; options → toggle buttons (single- or multi-select). On submit it
// emits [{question, answer}] and renders the chosen answers read-only. State is
// local + per-turn (the turn is never persisted — spec §1).
export default function FabryQuestions({ questions, onSubmit }) {
  const [answers, setAnswers] = useState(() => questions.map(() => ({ text: '', selected: [] })));
  const [submitted, setSubmitted] = useState(false);

  const setText = (i, v) => setAnswers((a) => a.map((x, j) => (j === i ? { ...x, text: v } : x)));
  const toggle = (i, opt, multi) => setAnswers((a) => a.map((x, j) => {
    if (j !== i) return x;
    if (!multi) return { ...x, selected: [opt] };
    return { ...x, selected: x.selected.includes(opt) ? x.selected.filter((o) => o !== opt) : [...x.selected, opt] };
  }));

  const answerFor = (q, a) => (q.options && q.options.length ? a.selected.join(', ') : a.text.trim());
  const complete = questions.every((q, i) => answerFor(q, answers[i]).length > 0);
  const collect = () => questions.map((q, i) => ({ question: q.question, answer: answerFor(q, answers[i]) }));

  if (submitted) {
    return (
      <div class="fabry-q fabry-q-done">
        {questions.map((q, i) => (
          <div key={i} class="fabry-q-item">
            <div class="fabry-q-text">{q.question}</div>
            <div class="fabry-q-answer">{answerFor(q, answers[i])}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div class="fabry-q">
      {questions.map((q, i) => (
        <div key={i} class="fabry-q-item">
          <div class="fabry-q-text">{q.question}</div>
          {q.options && q.options.length ? (
            <div class="fabry-q-opts">
              {q.options.map((opt, k) => (
                <button type="button" key={k} class={'fabry-q-opt' + (answers[i].selected.includes(opt) ? ' on' : '')} onClick={() => toggle(i, opt, q.multi_select)}>{opt}</button>
              ))}
            </div>
          ) : (
            <input class="fabry-q-input" type="text" value={answers[i].text} placeholder="Your answer" onInput={(e) => setText(i, e.target.value)} />
          )}
        </div>
      ))}
      <button type="button" class="fabry-q-submit" disabled={!complete} onClick={() => { setSubmitted(true); onSubmit(collect()); }}>
        {questions.length === 1 ? 'Send answer' : 'Send answers'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-questions.test.js` → pass. `npm test` → green.

---

### Task 5: `FabryNotice` component

**Files:**
- Create: `src/ui/fabry/FabryNotice.jsx`
- Test: `tests/ui-fabry-notice.test.js`

**Interfaces:**
- Consumes: a `notice` object from `fallbackNotice` (Task 1).
- Produces: `FabryNotice({ notice })` — renders `error` / `unsupported` (named + Details payload) / `empty`; `null` notice renders nothing.

- [ ] **Step 1: Write the failing tests** (`tests/ui-fabry-notice.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import FabryNotice from '../src/ui/fabry/FabryNotice.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(FabryNotice, props), root);
  return root;
}

describe('FabryNotice', () => {
  it('null notice renders nothing', () => {
    expect(mount({ notice: null }).querySelector('.fabry-notice')).toBeNull();
  });
  it('error shows the message', () => {
    expect(mount({ notice: { kind: 'error', text: 'boom' } }).querySelector('.fabry-notice-error').textContent).toContain('boom');
  });
  it('unsupported names the type and shows the raw payload in details', () => {
    const root = mount({ notice: { kind: 'unsupported', types: ['data-agent-confirmation'], payloads: [{ type: 'data-agent-confirmation', data: { prompt: 'ok?' } }] } });
    const el = root.querySelector('.fabry-notice-warn');
    expect(el.textContent).toContain('data-agent-confirmation');
    expect(el.querySelector('details pre').textContent).toContain('ok?');
  });
  it('empty shows a quiet no-response note', () => {
    expect(mount({ notice: { kind: 'empty' } }).querySelector('.fabry-notice-muted').textContent).toContain('no response');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ui-fabry-notice.test.js`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement** (`src/ui/fabry/FabryNotice.jsx`)

```jsx
import { h } from 'preact';

// Fallback renderer for a turn with nothing normally renderable (spec §6).
// Never blank: a stream error, an unsupported (future) interactive element
// named with its raw payload, or a quiet no-response note.
export default function FabryNotice({ notice }) {
  if (!notice) return null;
  if (notice.kind === 'error') {
    return <div class="fabry-notice fabry-notice-error">{notice.text || 'The agent reported an error.'}</div>;
  }
  if (notice.kind === 'unsupported') {
    return (
      <div class="fabry-notice fabry-notice-warn">
        <div>Mr. Fabry used an interactive element this version of the extension doesn{'’'}t support yet (<code>{notice.types.join(', ')}</code>). Update the extension, or continue this chat in the Rossum agent UI.</div>
        <details class="fabry-notice-details"><summary>Details</summary><pre>{JSON.stringify(notice.payloads, null, 2)}</pre></details>
      </div>
    );
  }
  return <div class="fabry-notice fabry-notice-muted">(no response)</div>;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/ui-fabry-notice.test.js` → pass. `npm test` → green.

---

### Task 6: Wire `AssistantTurn` + CSS

**Files:**
- Modify: `src/fabry/components/AssistantTurn.jsx`, `src/console/console.css`
- Test: `tests/fabry-thread-view.test.js`

**Interfaces:**
- Consumes: `FabryQuestions` (Task 4), `FabryNotice` + `fallbackNotice` (Tasks 5/1), `answerQuestions` (Task 3).
- Produces: an assistant turn renders markdown when it has text, a question form when it has questions, a fallback notice when neither; the feedback footer is suppressed on question/notice turns.

- [ ] **Step 1: Write the failing tests** (append to `tests/fabry-thread-view.test.js`; the file has `mount()` + `chat.js` mock + `beforeEach`)

Add `answerQuestions: vi.fn()` to the existing `vi.mock('../src/fabry/chat.js', …)` factory, then:

```js
  it('renders a question form for a question turn and suppresses feedback', () => {
    store.thread.value = [
      { role: 'user', chip: false, command: false, text: 'draft', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
      { role: 'assistant', chip: false, command: false, text: '', images: [], feedback: null, reasoning: '', tools: [], interrupted: false,
        questions: [{ question: 'Name?', options: [], multi_select: false }] },
    ];
    const root = mount();
    expect(root.querySelector('.fabry-q')).toBeTruthy();
    expect(root.querySelector('.fabry-turn-foot')).toBeNull(); // no feedback on a question turn
  });
  it('renders the unsupported-element notice for a text-less unknown turn', () => {
    store.thread.value = [
      { role: 'assistant', chip: false, command: false, text: '', images: [], feedback: null, reasoning: '', tools: [], interrupted: false,
        unhandled: [{ type: 'data-agent-confirmation', data: { prompt: 'ok?' } }] },
    ];
    const root = mount();
    expect(root.querySelector('.fabry-notice-warn').textContent).toContain('data-agent-confirmation');
    expect(root.querySelector('.fabry-turn-foot')).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-thread-view.test.js`
Expected: FAIL — `.fabry-q` / `.fabry-notice-warn` absent; footer still rendered.

- [ ] **Step 3: Implement** (`src/fabry/components/AssistantTurn.jsx`)

Add imports:

```js
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import FabryNotice from '../../ui/fabry/FabryNotice.jsx';
import FabryQuestions from './FabryQuestions.jsx';
import { toolLabel, fallbackNotice } from '../../agent/agentStream.js';
import { sendFeedback, openChat, answerQuestions } from '../chat.js';
```

Replace the body line `<FabryMarkdown text={turn.text} streaming={streaming} />` and the footer gate. New render (from the markdown line onward):

```jsx
      {(streaming || turn.text) ? <FabryMarkdown text={turn.text} streaming={streaming} /> : null}
      {!streaming && turn.questions ? <FabryQuestions questions={turn.questions} onSubmit={(a) => answerQuestions(a)} /> : null}
      {!streaming ? <FabryNotice notice={fallbackNotice(turn)} /> : null}
      {turn.interrupted && (
        <div class="fabry-interrupted">
          Stopped before the reply finished.{' '}
          <button type="button" class="fabry-refresh" onClick={() => openChat(store.activeChatId.value)}>Refresh from server</button>
        </div>
      )}
      {!streaming && !turn.interrupted && !turn.questions && !fallbackNotice(turn) && (
        <div class="fabry-turn-foot">
          {/* …existing footer buttons unchanged… */}
        </div>
      )}
```

(Keep the existing footer button markup and the existing `turn.deep` chip/strip blocks exactly as they are — only the footer's opening `{!streaming && !turn.interrupted && (` condition gains `&& !turn.questions && !fallbackNotice(turn)`.)

- [ ] **Step 4: CSS** (append to `src/console/console.css`)

```css
.fabry-q { display: flex; flex-direction: column; gap: 10px; margin: 8px 0; padding: 12px 14px; border: 1px solid var(--info-border); border-radius: 10px; background: var(--info-bg); }
.fabry-q-item { display: flex; flex-direction: column; gap: 6px; }
.fabry-q-text { font-size: 13px; font-weight: 600; }
.fabry-q-opts { display: flex; flex-wrap: wrap; gap: 6px; }
.fabry-q-opt { border: 1px solid var(--border); background: var(--bg-card); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.fabry-q-opt.on { border-color: var(--accent); color: var(--accent); background: var(--bg-hover); font-weight: 600; }
.fabry-q-input { border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; background: var(--bg-input); color: var(--text-primary); font-family: inherit; }
.fabry-q-input:focus { outline: 2px solid var(--info-border); }
.fabry-q-submit { align-self: flex-start; border: 0; background: var(--accent); color: var(--bg-card); font-weight: 650; border-radius: 8px; padding: 7px 16px; cursor: pointer; }
.fabry-q-submit:disabled { opacity: .5; cursor: default; }
.fabry-q-done .fabry-q-answer { font-size: 13px; color: var(--accent); }
.fabry-notice { margin: 8px 0; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; border: 1px solid var(--border); }
.fabry-notice-error { color: var(--danger-fg); border-color: var(--danger-border); background: var(--danger-bg); white-space: pre-wrap; }
.fabry-notice-warn { color: var(--warning-fg); border-color: var(--warning-border); background: var(--warning-bg); }
.fabry-notice-warn code { font-family: var(--font-mono); }
.fabry-notice-details { margin-top: 6px; }
.fabry-notice-details pre { margin-top: 4px; font-size: 11px; overflow-x: auto; }
.fabry-notice-muted { color: var(--text-secondary); font-style: italic; border: 0; background: none; padding: 0; }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/fabry-thread-view.test.js tests/fabry-app.test.js` → pass. `npm test` → green.

---

### Task 7: Docs, build, live verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md.** In the Fabry Chat section add a bullet: agent interactive elements (spec `docs/superpowers/specs/2026-07-13-fabry-agent-questions-design.md`) — `data-agent-question` renders as an inline `FabryQuestions` form (free-text / single / multi-select), answered by one message back to the same chat (`answerQuestions`/`formatAnswers`); deep verify skips question turns; and a fallback layer (`agentStream.fallbackNotice` + `src/ui/fabry/FabryNotice.jsx`) turns any unknown `data-*` element or stream `error` into a named notice instead of a blank turn — "never render nothing."

- [ ] **Step 2: Full verification.** `npm test` (green) + `npm run build` (clean). Remind the owner to reload the unpacked extension.

- [ ] **Step 3: Live gates (internal org, agent-browser recipe — memory `reference_extension_dogfood_agent_browser`).**
  1. Prompt "Ask me a question via data-agent-question" → the question renders as a form; answering it continues the chat.
  2. The SOW-email prompt ("Customer requires explanation of the SOW price increase…") → the agent loads the customer-email skill and asks for the customer name/context → form renders → filling + Send produces the drafted email.
  3. Reload the chat → the exchange is server-shaped (original prompt → answer → reply); no orphaned form, no blank turn.
  4. Deep verify ON + a question prompt → no verdict chip on the question turn; the answer's turn verifies normally.
  Record outcomes; fix + re-test anything that diverges.

---

## Self-Review Notes

- **Spec coverage:** §3 stream layer → Task 1; §4 view model + deep-verify skip → Tasks 2–3; §5 answer flow → Task 3; §6 components → Tasks 4–6; §7 tool labels → Task 1; §8 error handling → Tasks 1/3/6; §9 testing → per-task + Task 7 live gates; §10 out-of-scope respected (no persistence, no speculative rendering of unknown elements).
- **Type consistency:** `fallbackNotice(turn)` shape (`{kind, text?, types?, payloads?}`) defined in Task 1, consumed by `FabryNotice` (Task 5) and `AssistantTurn` (Task 6); `{question, answer}` answer shape produced by `FabryQuestions` (Task 4), consumed by `formatAnswers`/`answerQuestions` (Task 3); `{skipped:true}` produced by `runDeepTurn` (Task 2), consumed in `chat.js` (Task 3); `sendMainTurn` return `{text, verifiable}` defined in Task 3's chat.js, honored by Task 2's runDeepTurn.
- **Known judgment call (flagged for the implementer):** `AssistantTurn` calls `fallbackNotice(turn)` up to twice per render (footer gate + notice render). It's a pure O(1) function; fine to call twice, or hoist into a `const notice = !streaming ? fallbackNotice(turn) : null;` at the top of the component — implementer's choice, no behavior difference.
