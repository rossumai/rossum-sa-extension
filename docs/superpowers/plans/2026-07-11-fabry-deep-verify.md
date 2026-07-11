# Fabry Deep Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Deep verify" mode in Fabry Chat: each answer is adversarially verified by a fresh-chat critic and auto-refined (≤2 rounds), plus a popup kill switch.

**Architecture:** Pure orchestration in `src/fabry/deepLoop.js` (transport injected, like `agentQuery.js`); `chat.js` routes `sendMessage` through it when the mode is on; the critic runs in its own server chat primed cautious; verdict attaches to the final answer turn (in-memory only). Spec: `docs/superpowers/specs/2026-07-11-fabry-deep-verify-design.md`.

**Tech Stack:** Preact + signals, existing `src/agent/` transport, vitest/jsdom. **No new dependencies.**

## Global Constraints

- **No git commits during execution** (owner rule) — each task's gate is its green test run; the owner commits.
- Tests in `tests/*.test.js`, `h()` convention (no raw JSX in tests), `// @vitest-environment jsdom` where DOM is used; Preact state updates are microtask-deferred — use the file-local `flush()` helper before asserting post-event DOM.
- JSX gotcha: no `\uXXXX` escapes in JSX text/attributes — use `{'…'}` or literal glyphs.
- No customer names/data anywhere. No chat/verification content persisted client-side.
- Reviewer marker string is exactly `[deep-verify reviewer]` (spec §3); verdict first-line contract is `VERDICT: PASS` / `VERDICT: FAIL` (spec §3).
- Kill switch storage key `fabryDeepVerifyEnabled`, **default ON — only a stored `false` disables** (spec §4).
- Refine cap: **2 rounds** (spec §3). Critic failures → `inconclusive`, never auto-retried.
- Blue scheme tokens for all new CSS (`--accent`, `--info-*`); classes `.fabry-deep-*`.
- Full suite green after every task (`npm test`); final task also runs `npm run build` (loaded extension runs `dist/`).

---

### Task 1: `deepLoop.js` — pure orchestration

**Files:**
- Create: `src/fabry/deepLoop.js`
- Test: `tests/fabry-deeploop.test.js`

**Interfaces:**
- Consumes: nothing (fully injected).
- Produces:
  - `parseVerdict(text)` → `{verdict: 'pass'|'fail'|'inconclusive', issues: string[]}`
  - `buildCriticPrompt(question, answer)` → string
  - `buildReviewerMessage(issues)` → string starting with `[deep-verify reviewer]`
  - `runDeepTurn({question, images, sendMainTurn, runCriticTurn, onPhase, maxRounds = 2})` → `Promise<null | {verdict, issues, criticText, rounds}>` where:
    - `sendMainTurn(content, images?)` → `Promise<{text: string} | null>` (null = aborted/stale → runDeepTurn returns null immediately)
    - `runCriticTurn(prompt)` → `Promise<string | null>` (critic reply text; null = aborted; a THROW = critic unavailable → verdict `inconclusive`)
    - `onPhase({phase: 'verify'|'refine', round})` — called before each phase.

- [ ] **Step 1: Write the failing tests** (`tests/fabry-deeploop.test.js`)

```js
import { describe, it, expect, vi } from 'vitest';
import { parseVerdict, buildCriticPrompt, buildReviewerMessage, runDeepTurn } from '../src/fabry/deepLoop.js';

describe('parseVerdict', () => {
  it('reads first-line PASS/FAIL and collects issue bullets', () => {
    expect(parseVerdict('VERDICT: PASS\nAll claims check out.')).toEqual({ verdict: 'pass', issues: [] });
    const v = parseVerdict('VERDICT: FAIL\n- count is wrong\n* threshold misread\nprose');
    expect(v.verdict).toBe('fail');
    expect(v.issues).toEqual(['count is wrong', 'threshold misread']);
  });
  it('finds a buried or lowercase verdict line', () => {
    expect(parseVerdict('Let me check.\nverdict: pass').verdict).toBe('pass');
  });
  it('missing verdict → inconclusive', () => {
    expect(parseVerdict('I looked around and things seem fine.').verdict).toBe('inconclusive');
    expect(parseVerdict('').verdict).toBe('inconclusive');
  });
});

describe('buildCriticPrompt / buildReviewerMessage', () => {
  it('critic prompt carries question, answer, tool instruction, verdict contract', () => {
    const p = buildCriticPrompt('How many queues?', 'There is 1 queue.');
    expect(p).toContain('How many queues?');
    expect(p).toContain('There is 1 queue.');
    expect(p).toMatch(/VERDICT: PASS/);
    expect(p).toMatch(/VERDICT: FAIL/);
    expect(p).toMatch(/tools/i);
    expect(p).toMatch(/read-only/i);
  });
  it('reviewer message starts with the marker and lists issues', () => {
    const m = buildReviewerMessage(['a', 'b']);
    expect(m.startsWith('[deep-verify reviewer]')).toBe(true);
    expect(m).toContain('- a');
    expect(m).toContain('- b');
  });
});

describe('runDeepTurn', () => {
  const phases = () => { const seen = []; return { seen, onPhase: (p) => seen.push(`${p.phase}:${p.round}`) }; };

  it('pass on first verify: one critic call, no refine', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer v1' });
    const runCriticTurn = vi.fn().mockResolvedValue('VERDICT: PASS');
    const { seen, onPhase } = phases();
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase });
    expect(out).toEqual({ verdict: 'pass', issues: [], criticText: 'VERDICT: PASS', rounds: 0 });
    expect(sendMainTurn).toHaveBeenCalledTimes(1);
    expect(runCriticTurn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['verify:0']);
  });

  it('fail → refine → pass: reviewer message goes to the main chat', async () => {
    const sendMainTurn = vi.fn()
      .mockResolvedValueOnce({ text: 'answer v1' })
      .mockResolvedValueOnce({ text: 'answer v2' });
    const runCriticTurn = vi.fn()
      .mockResolvedValueOnce('VERDICT: FAIL\n- wrong count')
      .mockResolvedValueOnce('VERDICT: PASS');
    const { seen, onPhase } = phases();
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase });
    expect(out.verdict).toBe('pass');
    expect(out.rounds).toBe(1);
    expect(sendMainTurn.mock.calls[1][0]).toContain('[deep-verify reviewer]');
    expect(sendMainTurn.mock.calls[1][0]).toContain('- wrong count');
    expect(runCriticTurn.mock.calls[1][0]).toContain('answer v2'); // critic sees the LATEST answer
    expect(runCriticTurn.mock.calls[1][0]).toContain('q'); // and the ORIGINAL question
    expect(seen).toEqual(['verify:0', 'refine:1', 'verify:1']);
  });

  it('persistent fail stops at the round cap with issues surfaced', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer' });
    const runCriticTurn = vi.fn().mockResolvedValue('VERDICT: FAIL\n- still wrong');
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} });
    expect(out.verdict).toBe('fail');
    expect(out.issues).toEqual(['still wrong']);
    expect(out.rounds).toBe(2);
    expect(runCriticTurn).toHaveBeenCalledTimes(3); // initial + after each of 2 refines
    expect(sendMainTurn).toHaveBeenCalledTimes(3); // question + 2 reviewer messages
  });

  it('critic throw → inconclusive, answer kept, no refine', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'answer' });
    const runCriticTurn = vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
    const out = await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} });
    expect(out.verdict).toBe('inconclusive');
    expect(sendMainTurn).toHaveBeenCalledTimes(1);
  });

  it('aborted main turn (null) → returns null immediately', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue(null);
    const runCriticTurn = vi.fn();
    expect(await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} })).toBeNull();
    expect(runCriticTurn).not.toHaveBeenCalled();
  });

  it('aborted critic (null) → returns null', async () => {
    const sendMainTurn = vi.fn().mockResolvedValue({ text: 'a' });
    const runCriticTurn = vi.fn().mockResolvedValue(null);
    expect(await runDeepTurn({ question: 'q', sendMainTurn, runCriticTurn, onPhase: () => {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-deeploop.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/fabry/deepLoop.js`**

```js
// Deep-verify orchestration (spec §3): answer → fresh-chat critic → refine,
// capped. Pure: every side effect arrives injected (sendMainTurn/
// runCriticTurn/onPhase), so the loop is unit-testable end to end — the
// agentQuery.js precedent. The critic runs with NO shared context on purpose:
// same-chat "double-check" is self-agreement-biased prompt-following.

export const REVIEWER_MARKER = '[deep-verify reviewer]';

export function parseVerdict(text) {
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*verdict:\s*(pass|fail)\b/i);
    if (!m) continue;
    if (m[1].toLowerCase() === 'pass') return { verdict: 'pass', issues: [] };
    const issues = [];
    const after = String(text).split('\n').slice(String(text).split('\n').indexOf(line) + 1);
    for (const l of after) {
      const b = l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)/);
      if (b) issues.push(b[1]);
    }
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-deeploop.test.js` → all pass. Then `npm test` → green.

---

### Task 2: `thread.js` — display-chip vs command split

The server STORES `[deep-verify reviewer]` messages (it only strips `/`-commands + their acks), so reviewer turns must render as chips yet stay COUNTED in `serverMessageIndex` (spec §5).

**Files:**
- Modify: `src/fabry/thread.js`, `src/fabry/chat.js` (Turn shape only)
- Test: `tests/fabry-thread.test.js`

**Interfaces:**
- Produces: `Turn` gains `command: boolean` (true only for `/`-prefixed user turns; `chip` stays the display flag and is true for command AND reviewer turns). `serverMessageIndex` exclusion now keys on `command`.

- [ ] **Step 1: Write the failing tests** (append to `tests/fabry-thread.test.js`; also update the existing chip expectations to include `command`)

In the existing `normalizeMessages` test, extend the first assertion:

```js
    expect(turns[0]).toMatchObject({ role: 'user', chip: true, command: true, text: '/persona cautious' });
```

Append:

```js
describe('reviewer turns (deep verify)', () => {
  const msgs = [
    { role: 'user', content: '/persona cautious' },          // 0 command chip (stripped server-side)
    { role: 'assistant', content: 'Persona set.' },           // 1 command ack (stripped server-side)
    { role: 'user', content: 'question' },                    // 2 → server idx 0
    { role: 'assistant', content: 'answer v1' },              // 3 → server idx 1
    { role: 'user', content: '[deep-verify reviewer] fix:' }, // 4 → server idx 2 (STORED by server)
    { role: 'assistant', content: 'answer v2' },              // 5 → server idx 3
  ];
  it('reviewer messages are chips for display but NOT commands', () => {
    const t = normalizeMessages(msgs);
    expect(t[4]).toMatchObject({ chip: true, command: false });
    expect(t[0]).toMatchObject({ chip: true, command: true });
  });
  it('serverMessageIndex counts reviewer turns and their replies', () => {
    const t = normalizeMessages(msgs);
    expect(serverMessageIndex(t, 3)).toBe(1);
    expect(serverMessageIndex(t, 4)).toBe(2);  // reviewer turn is feedback-addressable
    expect(serverMessageIndex(t, 5)).toBe(3);  // the corrected answer
    expect(serverMessageIndex(t, 0)).toBe(-1); // command still excluded
    expect(serverMessageIndex(t, 1)).toBe(-1); // command ack still excluded
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-thread.test.js`
Expected: FAIL — `command` undefined; index math off for reviewer turns.

- [ ] **Step 3: Implement**

In `src/fabry/thread.js`, `normalizeMessages` map body becomes:

```js
    const text = partsToText(msg.content);
    const command = msg.role === 'user' && text.startsWith('/');
    const reviewer = msg.role === 'user' && text.startsWith('[deep-verify');
    return {
      role: msg.role,
      chip: command || reviewer,
      command,
      text,
      images: partsToImages(msg.content),
      feedback: msg.feedback ?? null,
      reasoning: '',
      tools: [],
      interrupted: false,
    };
```

In `serverMessageIndex`, the exclusion keys on `command` (extend the existing VERIFIED comment with one line: reviewer `[deep-verify` turns are plain user messages the server KEEPS, so only `command` turns are excluded):

```js
  const isExcluded = (i) => {
    const t = turns[i];
    if (t.command) return true;
    return i > 0 && turns[i - 1].command && t.role === 'assistant';
  };
```

In `src/fabry/chat.js`: `BLANK_TURN` gains `command: false`; the priming push becomes `pushTurn({ ...BLANK_TURN, role: 'user', chip: true, command: true, text: '/persona cautious' });`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-thread.test.js tests/fabry-chat.test.js tests/fabry-thread-view.test.js` → pass. `npm test` → green.

---

### Task 3: Store signals + popup kill switch + console mirror

**Files:**
- Modify: `src/fabry/store.js`, `src/popup/components/App.jsx`, `src/console/index.jsx`, `src/fabry/index.jsx`
- Test: `tests/fabry-chat.test.js` (store defaults asserted in Task 4's tests); popup change is wiring-only (same untested-mirror precedent as `experimentalUnlocked`)

**Interfaces:**
- Produces (in `src/fabry/store.js`):

```js
// Deep verify (spec 2026-07-11): per-session mode (never persisted), the
// popup kill switch mirror (fabryDeepVerifyEnabled, default ON — only a
// stored false disables), and the live phase indicator for the chips.
export const deepMode = signal(false);
export const deepVerifyAllowed = signal(true);
export const deepPhase = signal(null); // null | {phase: 'verify'|'refine', round}
```

- [ ] **Step 1: Add the signals** to `src/fabry/store.js` (block above; place after `personaChoice`).

- [ ] **Step 2: Popup toggle.** In `src/popup/components/App.jsx`: add `'fabryDeepVerifyEnabled'` to the storage-keys array (next to `'experimentalUnlocked'`), and inside the existing Experimental `toggle-group` (after the `annotateForMeEnabled` Toggle):

```jsx
                    <Toggle
                      id="fabryDeepVerifyEnabled"
                      label="Fabry: deep-verify loops"
                      hint="Allow the chat's answer→verify→refine loop (roughly 2–3× tokens per message)"
                      beta
                      checked={storageValues.fabryDeepVerifyEnabled !== false}
                      onChange={(v) => setStorageToggle('fabryDeepVerifyEnabled', v)}
                    />
```

- [ ] **Step 3: Console mirror.** In `src/console/index.jsx`: add `'experimentalUnlocked'`-style handling for the new key — include `'fabryDeepVerifyEnabled'` in the boot `chrome.storage.local.get([...])` list; after the unlock mirror line add:

```js
  fabryStore.deepVerifyAllowed.value = stored.fabryDeepVerifyEnabled !== false;
```

and extend the existing `chrome.storage.onChanged` listener body:

```js
    if (area === 'local' && changes.fabryDeepVerifyEnabled) {
      fabryStore.deepVerifyAllowed.value = changes.fabryDeepVerifyEnabled.newValue !== false;
    }
```

- [ ] **Step 4: Forced-off effect.** In `src/fabry/index.jsx`, inside the `if (!wired)` block add:

```js
    effect(() => { if (!store.deepVerifyAllowed.value) store.deepMode.value = false; });
```

- [ ] **Step 5: Run tests**

Run: `npm test` → green (wiring is exercised by Tasks 4–5 tests).

---

### Task 4: `chat.js` deep path

**Files:**
- Modify: `src/fabry/chat.js`
- Test: `tests/fabry-chat.test.js`

**Interfaces:**
- Consumes: `runDeepTurn`/`REVIEWER_MARKER` (Task 1), store signals (Task 3), `Turn.command` (Task 2).
- Produces: the final assistant turn of a deep send carries `turn.deep = {verdict, issues, criticText}`; `store.deepPhase` mirrors `onPhase`; critic chats are primed `/persona cautious`.

- [ ] **Step 1: Write the failing tests** (append to `tests/fabry-chat.test.js`; the file's `vi.mock` factory and helpers already exist)

```js
describe('deep verify send path', () => {
  function queueStreams(replies) {
    // Each call to streamMessage consumes the next scripted reply text.
    let call = 0;
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      const text = replies[Math.min(call, replies.length - 1)];
      call += 1;
      onEvent({ type: 'text-delta', delta: text });
      onEvent({ type: 'finish' });
    });
  }

  beforeEach(() => {
    store.personaChoice.value = 'default'; // skip main-chat priming for clarity
    store.deepVerifyAllowed.value = true;
    store.deepMode.value = true;
    store.activeChatId.value = 'chat_main';
  });

  it('fail → refine → pass: reviewer chip turn, verdict on the final answer', async () => {
    agentApi.createChat.mockResolvedValue('chat_critic');
    queueStreams([
      'answer v1',                    // main
      'ok',                           // critic priming ack (/persona cautious)
      'VERDICT: FAIL\n- wrong count', // critic verdict 1
      'answer v2',                    // main refine
      'ok',                           // critic 2 priming ack
      'VERDICT: PASS',                // critic verdict 2
    ]);
    const ok = await sendMessage('how many queues?', []);
    expect(ok).toBe(true);
    const turns = store.thread.value;
    const reviewer = turns.find((t) => t.text.startsWith('[deep-verify reviewer]'));
    expect(reviewer).toMatchObject({ role: 'user', chip: true, command: false });
    const final = turns[turns.length - 1];
    expect(final.role).toBe('assistant');
    expect(final.deep).toMatchObject({ verdict: 'pass' });
    expect(store.deepPhase.value).toBe(null);
    expect(store.streaming.value).toBe(false);
  });

  it('critic failure → answer kept, verdict inconclusive', async () => {
    agentApi.createChat.mockRejectedValue(Object.assign(new Error('Agent error 429'), { status: 429 }));
    queueStreams(['answer v1']);
    const ok = await sendMessage('q', []);
    expect(ok).toBe(true);
    const final = store.thread.value[store.thread.value.length - 1];
    expect(final.deep).toMatchObject({ verdict: 'inconclusive' });
  });

  it('kill switch off → plain single-turn path, no critic chat', async () => {
    store.deepVerifyAllowed.value = false;
    queueStreams(['plain answer']);
    const ok = await sendMessage('q', []);
    expect(ok).toBe(true);
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(store.thread.value[store.thread.value.length - 1].deep).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-chat.test.js`
Expected: FAIL — no deep path yet.

- [ ] **Step 3: Implement in `src/fabry/chat.js`**

Add imports:

```js
import { runDeepTurn } from './deepLoop.js';
```

Inside `sendMessage`, replace the block from `pushTurn({ ...BLANK_TURN, role: 'user', text, images });` through `pushTurn(accTurn(acc, false));` with:

```js
    const deep = store.deepMode.value && store.deepVerifyAllowed.value;
    if (!deep) {
      pushTurn({ ...BLANK_TURN, role: 'user', text, images });
      const acc = await streamTurn(chatId, text, { images, signal });
      if (id !== loadId) return false;
      pushTurn(accTurn(acc, false));
    } else {
      const result = await runDeepTurn({
        question: text,
        images,
        onPhase: (p) => { store.deepPhase.value = p; },
        // One user+assistant exchange in the MAIN chat. Reviewer messages
        // start with the marker → chip (display) but NOT command (Task 2).
        sendMainTurn: async (content, imgs) => {
          pushTurn({ ...BLANK_TURN, role: 'user', chip: content.startsWith('[deep-verify'), text: content, images: imgs || [] });
          const acc = await streamTurn(chatId, content, { images: imgs, signal });
          if (id !== loadId) return null;
          pushTurn(accTurn(acc, false));
          return { text: replyText(acc) };
        },
        // Fresh critic chat per verify pass, primed cautious; folds locally so
        // the critic never hijacks the main liveTurn display.
        runCriticTurn: async (prompt) => {
          const criticId = await agentApi.createChat();
          if (id !== loadId) return null;
          const fold = async (content) => {
            const acc = newAcc();
            await agentApi.streamMessage(criticId, content, { signal, onEvent: (e) => foldEvents(acc, [e]) });
            return replyText(acc);
          };
          await fold('/persona cautious');
          if (id !== loadId) return null;
          const text2 = await fold(prompt);
          return id === loadId ? text2 : null;
        },
      });
      if (id !== loadId) return false;
      if (result) {
        // Attach the verdict to the last assistant turn.
        const turns = store.thread.value;
        for (let i = turns.length - 1; i >= 0; i -= 1) {
          if (turns[i].role === 'assistant') {
            store.thread.value = turns.map((t, j) => (j === i ? { ...t, deep: { verdict: result.verdict, issues: result.issues, criticText: result.criticText } } : t));
            break;
          }
        }
      }
    }
```

In the `finally` block add `store.deepPhase.value = null;` next to the existing resets. Note: `runCriticTurn`'s exceptions must NOT be swallowed here — `runDeepTurn` already maps a critic throw to `inconclusive`, and an ABORT surfaces as `streamMessage` throwing AbortError inside `sendMainTurn`/`fold`, which propagates to `sendMessage`'s existing catch. Add a guard in `runCriticTurn` so an abort isn't misread as "critic unavailable": wrap the two `fold` calls in `try/catch` and `if (signal.aborted) return null; throw err;`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-chat.test.js tests/fabry-deeploop.test.js` → pass. `npm test` → green.

---

### Task 5: UI — toggle, phase chips, verdict chip + strip

**Files:**
- Modify: `src/fabry/components/Composer.jsx`, `src/fabry/components/Thread.jsx`, `src/fabry/components/AssistantTurn.jsx`, `src/console/console.css`
- Test: `tests/fabry-composer.test.js`, `tests/fabry-thread-view.test.js`

**Interfaces:**
- Consumes: `store.deepMode/deepVerifyAllowed/deepPhase`, `turn.deep` (Task 4).

- [ ] **Step 1: Write the failing tests**

Append to `tests/fabry-composer.test.js`:

```js
describe('deep verify toggle', () => {
  it('renders when allowed, flips deepMode, hidden when killed', async () => {
    store.deepVerifyAllowed.value = true;
    store.deepMode.value = false;
    const root = mount(Composer, {});
    const btn = root.querySelector('.fabry-deep-toggle');
    expect(btn).toBeTruthy();
    btn.click();
    expect(store.deepMode.value).toBe(true);
    store.deepVerifyAllowed.value = false;
    const root2 = mount(Composer, {});
    expect(root2.querySelector('.fabry-deep-toggle')).toBeNull();
  });
});
```

Append to `tests/fabry-thread-view.test.js` (inside the existing describe or a new one; the mock and `beforeEach` already exist — reset `store.deepPhase.value = null` in `beforeEach`):

```js
  it('shows the deep phase chip while verifying', () => {
    store.streaming.value = true;
    store.liveTurn.value = { reasoning: '', text: 'x', tools: [] };
    store.deepPhase.value = { phase: 'verify', round: 0 };
    const root = mount();
    expect(root.querySelector('.fabry-deep-phase').textContent).toContain('Verifying in a fresh chat');
    store.deepPhase.value = { phase: 'refine', round: 2 };
    const root2 = mount();
    expect(root2.querySelector('.fabry-deep-phase').textContent).toContain('Refining 2/2');
  });
  it('verdict chip renders per state and expands the critic strip', async () => {
    store.thread.value = [
      { role: 'user', chip: false, command: false, text: 'q', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
      { role: 'assistant', chip: false, command: false, text: 'a', images: [], feedback: null, reasoning: '', tools: [], interrupted: false,
        deep: { verdict: 'fail', issues: ['wrong count'], criticText: 'VERDICT: FAIL\n- wrong count' } },
    ];
    const root = mount();
    const chipEl = root.querySelector('.fabry-deep-chip.fail');
    expect(chipEl.textContent).toContain('1 unresolved issue');
    chipEl.click();
    await flush();
    expect(root.querySelector('.fabry-deep-strip').textContent).toContain('wrong count');
  });
```

(`tests/fabry-thread-view.test.js` needs the same `flush()` helper line the composer test file uses if not present: `const flush = () => new Promise((r) => setTimeout(r, 0));`)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-composer.test.js tests/fabry-thread-view.test.js` → FAIL.

- [ ] **Step 3: Implement**

`Composer.jsx` — in the persona row, make the row render always (not only `isNewChat`), keep the picker gated, and add the toggle:

```jsx
      <div class="fabry-persona">
        {isNewChat && <span class="fabry-persona-label">Persona</span>}
        {isNewChat && (
          <span class="fabry-persona-seg">
            {PERSONAS.map((p) => (
              <button type="button" key={p.value} title={p.hint} class={store.personaChoice.value === p.value ? 'on' : ''} onClick={() => { store.personaChoice.value = p.value; }}>{p.label}</button>
            ))}
          </span>
        )}
        {isNewChat && <span class="fabry-persona-hint">{PERSONAS.find((p) => p.value === store.personaChoice.value)?.hint}</span>}
        {store.deepVerifyAllowed.value && (
          <button
            type="button"
            class={'fabry-deep-toggle' + (store.deepMode.value ? ' on' : '')}
            title="Verifies each answer in a fresh chat and auto-fixes issues. Roughly 2–3× tokens and latency per message."
            onClick={() => { store.deepMode.value = !store.deepMode.value; }}
          >
            {'✦'} Deep verify
          </button>
        )}
      </div>
```

`Thread.jsx` — above the live `AssistantTurn` (inside the `store.streaming.value && live` block, before it):

```jsx
      {store.streaming.value && store.deepPhase.value && (
        <div class="fabry-deep-phase">
          {store.deepPhase.value.phase === 'verify'
            ? 'Verifying in a fresh chat…'
            : `Refining ${store.deepPhase.value.round}/2…`}
        </div>
      )}
```

`AssistantTurn.jsx` — add `useState` for the strip and render in the footer block (only when `!streaming && !turn.interrupted`), after the Copy button:

```jsx
  const [showDeep, setShowDeep] = useState(false);
```

```jsx
          {turn.deep && (
            <button type="button" class={'fabry-deep-chip ' + turn.deep.verdict} onClick={() => setShowDeep(!showDeep)}>
              {turn.deep.verdict === 'pass' && <span>{'✓'} Independently verified</span>}
              {turn.deep.verdict === 'fail' && <span>{'⚠'} {turn.deep.issues.length} unresolved issue{turn.deep.issues.length === 1 ? '' : 's'}</span>}
              {turn.deep.verdict === 'inconclusive' && <span>Verification inconclusive</span>}
            </button>
          )}
```

and after the footer div:

```jsx
      {turn.deep && showDeep && (
        <div class="fabry-deep-strip">
          <FabryMarkdown text={turn.deep.criticText || '(no critic output)'} />
        </div>
      )}
```

`src/console/console.css` — append:

```css
.fabry-deep-toggle { margin-left: auto; border: 1px solid var(--border); background: none; color: var(--text-secondary); border-radius: 999px; padding: 3px 12px; font-size: 11px; cursor: pointer; }
.fabry-deep-toggle.on { border-color: var(--info-border); color: var(--accent); background: var(--info-bg); font-weight: 600; }
.fabry-deep-phase { align-self: flex-start; font-size: 10.5px; color: var(--accent); border: 1px dashed var(--info-border); border-radius: 999px; padding: 2px 10px; }
.fabry-deep-chip { border: 1px solid var(--border); background: none; border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
.fabry-deep-chip.pass { color: var(--success-fg); border-color: var(--success-border); background: var(--success-bg); }
.fabry-deep-chip.fail { color: var(--warning-fg); border-color: var(--warning-border); background: var(--warning-bg); }
.fabry-deep-chip.inconclusive { color: var(--text-secondary); }
.fabry-deep-strip { border: 1px solid var(--info-border); border-radius: 8px; background: var(--info-bg); padding: 8px 12px; margin-top: 6px; font-size: 12px; }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-composer.test.js tests/fabry-thread-view.test.js` → pass. `npm test` → green. `npm run build` → clean.

---

### Task 6: Docs, build, live verification gates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md.** In the Fabry Chat section add a bullet: Deep verify (spec `docs/superpowers/specs/2026-07-11-fabry-deep-verify-design.md`) — composer toggle (session-only) routes sends through `deepLoop.js` (answer → fresh-chat critic primed cautious with a `VERDICT:` contract → `[deep-verify reviewer]` refine messages, cap 2 rounds); verdict chip + critic strip on the final answer; reviewer turns are display chips but COUNTED in `serverMessageIndex` (server stores them, unlike `/`-commands); kill switch `fabryDeepVerifyEnabled` (popup Experimental, default ON, mirrored live). In Chrome Storage Keys: add `fabryDeepVerifyEnabled` to the feature-toggle list.

- [ ] **Step 2: Full verification.** `npm test` (green) and `npm run build` (clean); remind the owner to reload the unpacked extension.

- [ ] **Step 3: Live gates (internal org, agent-browser recipe).** (1) Deep send end-to-end: toggle on, ask a verifiable question; watch phase chips; confirm the critic chat appears in the sidebar and its stream used tools (chips in the critic chat when opened). (2) Verdict chip renders and the strip shows the critic text. (3) Kill switch: flip off in the popup with the Console open → toggle disappears and deepMode turns off. (4) Stop mid-verify → loop stops, answer kept, no verdict chip. (5) Reload the chat → reviewer turns render as chips; thumbs on the corrected answer lands on the right server message (`GET /chats/{id}` check).

---

## Self-Review Notes

- Spec coverage: §2 UX → Task 5; §3 loop → Tasks 1+4; §4 kill switch → Task 3 (+5 gating test); §5 code shape → Tasks 1–5 as specified (incl. the chip/command split in Task 2); §6 testing → per-task + Task 6 live gates; §7 out-of-scope respected (no persistence, no critic-chat hiding).
- Type consistency: `runDeepTurn` deps signature identical in Task 1 tests/impl and Task 4 call site; `turn.deep = {verdict, issues, criticText}` written in Task 4, read in Task 5; `Turn.command` defined in Task 2, set by Task 4's reviewer push (`chip: startsWith marker, command: false` — matches `BLANK_TURN.command = false`).
- Known judgment call, flagged for the implementer: Task 4's scripted-stream test assumes critic priming consumes one scripted reply ("ok") — if the real mock ordering differs (priming happens per critic chat), adjust the `queueStreams` script accordingly rather than the implementation.
