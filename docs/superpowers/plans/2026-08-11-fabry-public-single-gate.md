# Fabry Public / Single Hidden-Features Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mr. Fabry visible to every user with no unlock gesture, and collapse the two unlock keys into one — `experimentalUnlocked` — which now hides only the Academy, badged `EXP`.

**Architecture:** Purely subtractive on the gating side. `src/console/boot.js` drops its fabry clauses and collapses two gate flags into one `unlocked`; `Rail.jsx` renders Fabry unconditionally and gates only the Academy; `src/training/storage.js` repoints `UNLOCK_KEY` at `experimentalUnlocked`, which moves the content-script quest card — the only consumer of `src/training/gate.js` — onto the new key, while the Academy's own visibility is moved separately, by the Console rail and shell reading the same `experimentalUnlocked` signal; the popup writes one key instead of two. Two paths, one key. No storage migration exists or is needed (see Global Constraints).

**Tech Stack:** Preact + `@preact/signals`, esbuild, Vitest (jsdom for component tests), plain CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-08-11-fabry-public-single-gate-design.md`

## Global Constraints

- **Never run `git commit`.** Repo rule: the owner commits, and a run's work lands as exactly ONE commit that they make. End every task with `git add` only. Never create branches or worktrees.
- **Never add a `Co-Authored-By: Claude` trailer** to anything.
- Tests are `.test.js` (never `.jsx`) and render components via `h(Component, null)` — the repo's test discovery only transforms `.jsx` sources, so raw JSX inside a test file fails to parse.
- Run the whole suite with `npm test`; a single file with `npx vitest run tests/<file>.test.js`; a single case with `-t "<name>"`.
- **Rebuild `dist/` after any UI change** (`npm run build`). Tests run `src/`, but the loaded Chrome extension runs `dist/` — an unbuilt change looks like it did nothing.
- CSS variables: `--info-bg` / `--info-fg` **are** defined (`src/console/console.css:29-31` light, `:81-83` dark). `--accent-bg` / `--accent-fg` are **never defined** — only `--accent` and `--accent-hover` — so a badge tinted with them renders transparent. Use `--info-*`.
- Measured badge geometry (headless, against the live stylesheet): rail 76px, rail item 60px, existing `beta` pill 30.2px wide / 36.2px span from the item's right edge. A pill reading `exp` at the unchanged 7.5px uppercase style is **25.1px / 31.1px span** — narrower than `beta`, so it needs no type concession.
- **No storage migration.** `trainingUnlocked` only ever existed in commit `9730a29` (HEAD, five commits past the released version 0.330 = `7348ae7`), and that commit already writes both keys in a single `chrome.storage.local.set`. No profile anywhere can hold `trainingUnlocked: true` without `experimentalUnlocked: true`. Do not write migration code.
- Never put a customer name, org name, or document content into code, tests, comments, or docs.
- Unicode escapes (`\uXXXX`) do not work in JSX **text children or attribute values** — but the em dash in this plan lives in a plain JS string literal inside an array, where escapes are fine. Use the literal `—` character anyway for readability.

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `src/console/boot.js` | Pure app-selection helpers. One gate flag (`unlocked`), gating `academy` only. |
| `src/console/store.js` | Console signals. `experimentalUnlocked` only; `trainingUnlocked` deleted. |
| `src/console/index.jsx` | Shell wiring: reads one gate key, mirrors it, feeds boot helpers. |
| `src/console/components/Rail.jsx` | App switcher. Fabry always rendered; Academy gated + `EXP` badge. |
| `src/console/console.css` | Adds `.app-rail-exp` beside `.app-rail-beta` (same pill, `--info-*` tint). |
| `src/training/storage.js` | `UNLOCK_KEY` — the single name of the gate, imported by `gate.js` (whose only consumer is the content-script quest card; the Academy's visibility is separately wired through the Console rail/shell onto the same key). |
| `src/training/gate.js` | Gate read + subscription. Comment states the current, true rationale. |
| `src/popup/components/App.jsx` | Writes the one gate key; notice copy says "Experimental features". |
| `CLAUDE.md`, `PRIVACY.md` | Architecture + privacy docs brought in line. |

Task order matters. Task 1 changes `pickInitialApp`'s signature before Task 3 updates its only production caller; in that window an unlocked user's persisted `academy` falls back to `mdh` (the fail-safe direction) — expected, not a defect, and closed by Task 3.

---

### Task 1: Collapse `boot.js` to one gate

**Files:**
- Modify: `src/console/boot.js:10-29`
- Test: `tests/console-boot.test.js:101-116`, `tests/console-academy-wiring.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pickInitialApp({ stagingApp, persistedApp, unlocked = false })` → app id string; `appAfterGateChange(activeApp, unlocked)` → app id string. `isValidApp(v)` is unchanged. Task 3 calls both with these exact names.

- [ ] **Step 1: Rewrite the failing tests**

Replace the whole `describe('fabry experimental gate', …)` block at `tests/console-boot.test.js:101-116` with:

```js
describe('fabry is public (no gate)', () => {
  it('isValidApp accepts fabry', () => {
    expect(isValidApp('fabry')).toBe(true);
  });
  // Fabry took an `experimentalUnlocked` gate until 2026-08-11. It is now a
  // normal app: no flag, in either direction, may keep it off the rail.
  it('pickInitialApp yields fabry with no unlock flag at all', () => {
    expect(pickInitialApp({ persistedApp: 'fabry' })).toBe('fabry');
    expect(pickInitialApp({ stagingApp: 'fabry', persistedApp: 'audit' })).toBe('fabry');
  });
  it('appAfterGateChange never moves fabry, locked or unlocked', () => {
    expect(appAfterGateChange('fabry', false)).toBe('fabry');
    expect(appAfterGateChange('fabry', true)).toBe('fabry');
    expect(appAfterGateChange('audit', false)).toBe('audit');
  });
});
```

Replace the entire body of `tests/console-academy-wiring.test.js` (keep its two import lines) with:

```js
describe('academy in the app registry', () => {
  it('is a valid app', () => {
    expect(isValidApp('academy')).toBe(true);
  });

  it('is only picked on boot when the experimental gate is unlocked', () => {
    expect(pickInitialApp({ persistedApp: 'academy', unlocked: true })).toBe('academy');
    expect(pickInitialApp({ persistedApp: 'academy', unlocked: false })).toBe('mdh');
  });

  // The default is LOCKED on purpose: a caller that forgets the flag must HIDE
  // the Academy, never reveal it. This is the whole reason the parameter has a
  // default at all.
  it('defaults to locked when the flag is omitted entirely', () => {
    expect(pickInitialApp({ persistedApp: 'academy' })).toBe('mdh');
    expect(pickInitialApp({ stagingApp: 'academy' })).toBe('mdh');
  });

  it('falls back to mdh when the gate re-locks while the Academy is open', () => {
    expect(appAfterGateChange('academy', false)).toBe('mdh');
    expect(appAfterGateChange('academy', true)).toBe('academy');
    expect(appAfterGateChange('mdh', false)).toBe('mdh');
  });

  it('leaves staging-app precedence intact', () => {
    expect(pickInitialApp({ stagingApp: 'audit', persistedApp: 'mdh' })).toBe('audit');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/console-boot.test.js tests/console-academy-wiring.test.js`
Expected: FAIL — `pickInitialApp({ persistedApp: 'fabry' })` returns `'mdh'` (the old default-locked fabry clause), and `pickInitialApp({ persistedApp: 'academy', unlocked: true })` returns `'mdh'` because the old signature ignores `unlocked`.

- [ ] **Step 3: Rewrite the two helpers**

In `src/console/boot.js`, replace lines 10-29 (the comment above `pickInitialApp` through the end of `appAfterGateChange`) with:

```js
// Which app to show on boot. Precedence: staging entry (a popup button click)
// wins, then the persisted last-used app, then Dataset Management. The Academy
// is the ONE gated app — everything else, Mr. Fabry included, is always
// available. `unlocked` defaults to locked so a caller that forgets the flag
// hides the Academy rather than revealing it.
export function pickInitialApp({ stagingApp, persistedApp, unlocked = false } = {}) {
  const ok = (v) => isValidApp(v) && (v !== 'academy' || unlocked);
  if (ok(stagingApp)) return stagingApp;
  if (ok(persistedApp)) return persistedApp;
  return 'mdh';
}

// Re-locking the gate while the Academy is active falls back to Dataset
// Management; every other app is unaffected.
export function appAfterGateChange(activeApp, unlocked) {
  if (activeApp === 'academy' && !unlocked) return 'mdh';
  return activeApp;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/console-boot.test.js tests/console-academy-wiring.test.js`
Expected: PASS, all cases in both files.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/console/boot.js tests/console-boot.test.js tests/console-academy-wiring.test.js
```

---

### Task 2: Rail — Fabry public, Academy behind the gate with an `EXP` badge

**Files:**
- Modify: `src/console/components/Rail.jsx:51-81`
- Modify: `src/console/console.css:3001-3009`
- Test: `tests/console-rail.test.js`

**Interfaces:**
- Consumes: `experimentalUnlocked` signal from `src/console/store.js` (already exported; Task 3 removes only `trainingUnlocked`).
- Produces: rail markup where the academy row carries `<span class="app-rail-exp">exp</span>` and `title="Onboarding training — experimental"`, and the fabry row renders with no gate.

- [ ] **Step 1: Rewrite the failing tests**

In `tests/console-rail.test.js`:

(a) Change the import at line 5 to drop `trainingUnlocked`:

```js
import { activeApp, experimentalUnlocked } from '../src/console/store.js';
```

(b) In the first `beforeEach` (lines 19-23), delete the `trainingUnlocked.value = false;` line.

(c) Line 27: `expect(root.querySelectorAll('.app-rail-item').length).toBe(4);` → `.toBe(5);`

(d) Replace the test at lines 49-60 with this — the old one unlocked the gate to reveal Fabry, which would now also reveal the Academy and put it *after* Galaxy:

```js
  it('renders Galaxy as the last rail item, after the now-public Fabry item', () => {
    // Assert with the gate LOCKED. Fabry is public, so it is on the rail either
    // way, while the Academy — which sits after Galaxy — is hidden, which is
    // what makes "Galaxy is last" a real assertion rather than a trivial one.
    experimentalUnlocked.value = false;
    const items = [...mount().querySelectorAll('.app-rail-item')];
    const title = (b) => b.getAttribute('title');
    const idx = (t) => items.findIndex((b) => title(b) === t);
    expect(title(items[items.length - 1])).toBe('Org Galaxy');
    expect(idx('Mr. Fabry')).toBeLessThan(idx('Org Galaxy'));
  });
```

(e) In the test at lines 77-85 ('renders the Fabry rail icon as a STATIC shared FabryMark'), delete the line `experimentalUnlocked.value = true;` — Fabry no longer needs unlocking.

(f) Replace the whole `describe('Rail — fabry gate', …)` block (lines 110-131) with:

```js
describe('Rail — fabry is public', () => {
  it('shows Fabry with its beta badge while the experimental gate is LOCKED', () => {
    experimentalUnlocked.value = false;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find((b) => b.getAttribute('title') === 'Mr. Fabry');
    expect(btn).toBeTruthy();
    expect(btn.querySelector('.app-rail-beta').textContent).toBe('beta');
    expect(btn.querySelector('.app-rail-exp')).toBeNull(); // public: beta, never exp
    btn.click();
    expect(activeApp.value).toBe('fabry');
  });
});
```

(g) Replace the whole `describe('Rail — academy (training) gate', …)` block (lines 133-175) with:

```js
describe('Rail — academy (experimental) gate', () => {
  const ACADEMY_TITLE = 'Onboarding training — experimental';

  it('hides Academy while the gate is locked', () => {
    experimentalUnlocked.value = false;
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(5);
    expect([...root.querySelectorAll('.app-rail-item')].some((b) => b.getAttribute('title') === ACADEMY_TITLE)).toBe(false);
  });

  it('shows Academy with an EXP badge when unlocked, and switches on click', () => {
    experimentalUnlocked.value = true;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find((b) => b.getAttribute('title') === ACADEMY_TITLE);
    expect(btn).toBeTruthy();
    // exp REPLACES beta on a gated app: the badge names the gate it sits behind.
    expect(btn.querySelector('.app-rail-exp').textContent).toBe('exp');
    expect(btn.querySelector('.app-rail-beta')).toBeNull();
    btn.click();
    expect(activeApp.value).toBe('academy');
  });

  // The consolidation itself: ONE key now drives the Academy and nothing else.
  // Before 2026-08-11 two keys drove two apps, and the pair of tests here
  // asserted they could not cross-unlock. The risk now runs the other way — that
  // the surviving gate quietly re-acquires Fabry — so that is what this pins.
  it('drives the Academy alone; Fabry is present in both gate states', () => {
    experimentalUnlocked.value = false;
    let titles = [...mount().querySelectorAll('.app-rail-item')].map((b) => b.getAttribute('title'));
    expect(titles).toContain('Mr. Fabry');
    expect(titles).not.toContain(ACADEMY_TITLE);

    experimentalUnlocked.value = true;
    titles = [...mount().querySelectorAll('.app-rail-item')].map((b) => b.getAttribute('title'));
    expect(titles).toContain('Mr. Fabry');
    expect(titles).toContain(ACADEMY_TITLE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/console-rail.test.js`
Expected: FAIL — the default rail still renders 4 items (Fabry gated out), and no `.app-rail-exp` element exists.

- [ ] **Step 3: Update the Rail component**

In `src/console/components/Rail.jsx`, replace the `APPS` array (lines 51-59) with:

```js
const APPS = [
  { id: 'mdh', label: 'Data', title: 'Dataset Management', icon: DATA_ICON },
  { id: 'audit', label: 'Audit', title: 'Audit Log Viewer', icon: AUDIT_ICON },
  { id: 'inspector', label: 'Inspector', title: 'Annotation Inspector', icon: INSPECTOR_ICON, beta: true },
  { id: 'fabry', label: 'Fabry', title: 'Mr. Fabry', icon: FABRY_ICON, beta: true },
  { id: 'galaxy', label: 'Galaxy', title: 'Org Galaxy', icon: GALAXY_ICON },
  // `gated` hides the row unless experimentalUnlocked is set; `exp` is the
  // badge that names that gate. The title spells the abbreviation out, since
  // "EXP" alone does not tell a first-time reader what it means.
  { id: 'academy', label: 'Academy', title: 'Onboarding training — experimental', icon: ACADEMY_ICON, exp: true, gated: true },
];
```

Then replace the component body (lines 61-81) with:

```js
export default function Rail() {
  const active = activeApp.value;
  const unlocked = experimentalUnlocked.value;
  return (
    <nav class="app-rail" aria-label="Application switcher">
      {APPS.filter((a) => !a.gated || unlocked).map((a) => (
        <button
          type="button"
          class={'app-rail-item' + (active === a.id ? ' active' : '') + (a.muted ? ' muted' : '')}
          title={a.title}
          aria-current={active === a.id ? 'page' : undefined}
          onClick={() => { activeApp.value = a.id; }}
        >
          <span class="app-rail-icon">{a.icon}</span>
          <span class="app-rail-label">{a.label}</span>
          {a.beta && <span class="app-rail-beta">beta</span>}
          {a.exp && <span class="app-rail-exp">exp</span>}
        </button>
      ))}
    </nav>
  );
}
```

Finally, change the import on line 3 to drop `trainingUnlocked`:

```js
import { activeApp, experimentalUnlocked } from '../store.js';
```

- [ ] **Step 4: Add the badge CSS**

In `src/console/console.css`, change the selector on line 3001 from `.app-rail-beta {` to a shared list, and add the tint override immediately after the closing brace (line 3009). The block becomes:

```css
.app-rail-beta,
.app-rail-exp {
  position: absolute;
  top: 2px; right: 6px;            /* sits slightly over the top-right of the icon */
  font-size: 7.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
  padding: 1px 4px; border-radius: 999px;
  background: var(--warning-bg); color: var(--warning-fg);
  line-height: 1.3;
  pointer-events: none;            /* don't intercept clicks on the rail item */
}

/* EXP marks an app hidden behind the experimentalUnlocked gate, as opposed to
   BETA's "visible but immature". Same pill, same type — measured 25.1px against
   beta's 30.2px in a 60px rail item, so the longer word needs no concession —
   distinguished only by tint. --info-* and NOT --accent-bg/--accent-fg: those
   two are never defined in this file, so they would render a transparent pill. */
.app-rail-exp { background: var(--info-bg); color: var(--info-fg); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/console-rail.test.js`
Expected: PASS, all cases.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/console/components/Rail.jsx src/console/console.css tests/console-rail.test.js
```

---

### Task 3: Console shell wiring — one key, one mirror, one effect

**Files:**
- Modify: `src/console/store.js:7-14`
- Modify: `src/console/index.jsx:3, 111-139, 159-164`

**Interfaces:**
- Consumes: `pickInitialApp({ stagingApp, persistedApp, unlocked })` and `appAfterGateChange(activeApp, unlocked)` from Task 1; the `gated`/`exp` rail rows from Task 2.
- Produces: nothing new for later tasks. This is the last production caller of the old two-flag signature.

There is no unit test for this file — it is chrome-API glue, and the repo's precedent (the original Fabry gate, and the popup mirror before it) is to leave the mirror untested and verify via the full suite plus a build. Do not invent a mock harness for it.

- [ ] **Step 1: Delete the `trainingUnlocked` signal**

In `src/console/store.js`, replace lines 7-14 with:

```js
// The extension's one hidden-features gate (popup-owned; 5 quick clicks on the
// version hash). Mirrored from chrome.storage.local at boot and live via
// onChanged. It hides exactly one app today — the Academy — and Mr. Fabry is
// public. The separate `trainingUnlocked` signal was folded into this one on
// 2026-08-11; see src/training/gate.js for why the split stopped buying safety.
export const experimentalUnlocked = signal(false);
```

- [ ] **Step 2: Update the shell wiring**

In `src/console/index.jsx`:

(a) Line 3 → `import { activeApp, experimentalUnlocked } from './store.js';`

(b) In the `chrome.storage.local.get([...])` array (lines 111-116), delete the `'trainingUnlocked',` entry.

(c) Replace lines 121-139 (the mirror, the listener, and the gate effect) with:

```js
  experimentalUnlocked.value = !!stored.experimentalUnlocked;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.experimentalUnlocked) {
      experimentalUnlocked.value = !!changes.experimentalUnlocked.newValue;
    }
  });
  // Re-locking the gate while the Academy is active falls back to Dataset
  // Management; any other active app is unaffected. Subscribes only to the gate
  // signal (via .value) and reads activeApp with .peek() so this effect doesn't
  // re-run on every app switch — just on gate changes.
  effect(() => {
    activeApp.value = appAfterGateChange(activeApp.peek(), experimentalUnlocked.value);
  });
```

Keep the two-line comment above them (lines 119-120, about deep-verify and implement being ON by default) exactly as it is — it is still true.

(d) Replace the `pickInitialApp` call (lines 159-164) with:

```js
  const initial = pickInitialApp({
    stagingApp,
    persistedApp,
    unlocked: !!stored.experimentalUnlocked,
  });
```

- [ ] **Step 3: Verify nothing still references the removed signal**

Run: `grep -rn "trainingUnlocked" src/console/`
Expected: no output.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS except for the files Tasks 4-5 still have to update — at this point `tests/popup-training-gate.test.js` and `tests/training-content-wiring.test.js` may still pass (they exercise `trainingUnlocked`, which is still the key until Task 4). If anything else fails, fix it before moving on.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/console/store.js src/console/index.jsx
```

---

### Task 4: Point the training gate at `experimentalUnlocked`

**Files:**
- Modify: `src/training/storage.js:6`
- Modify: `src/training/gate.js:1-5`
- Test: `tests/training-storage.test.js` (append), `tests/training-content-wiring.test.js:12-20`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `UNLOCK_KEY === 'experimentalUnlocked'`, exported from `src/training/storage.js`. `isUnlocked()` / `onUnlockChange(cb)` in `src/training/gate.js` keep their signatures — `src/rossum/features/training-quest.js` and `src/academy/` call them unchanged.

- [ ] **Step 1: Write the failing tests**

Append to the end of `tests/training-storage.test.js` (the file already imports `UNLOCK_KEY` on line 3 — do not add a second import):

```js
describe('the unlock gate key', () => {
  // Load-bearing, and the single point the 2026-08-11 consolidation turns on:
  // the content script's quest card gates on this constant, the popup writes
  // the key by name, and the Console rail reads its own signal off the same
  // key. If any of the three names a different key, the Academy unlocks on one
  // surface and stays hidden on the others.
  it('is experimentalUnlocked — the one hidden-features gate', () => {
    expect(UNLOCK_KEY).toBe('experimentalUnlocked');
  });
});
```

Replace the two tests at `tests/training-content-wiring.test.js:12-20` with:

```js
  it('starts it OUTSIDE the SETTINGS_KEYS block — it self-gates on experimentalUnlocked', () => {
    const settingsIdx = SRC.indexOf('chrome.storage.local.get(SETTINGS_KEYS)');
    expect(SRC.indexOf('initTrainingQuest()')).toBeLessThan(settingsIdx);
  });

  // The quest card reads the gate through src/training/gate.js, never through
  // the content script's feature-toggle block. Adding it there would make the
  // card a toggle-driven feature and re-introduce a second read path.
  it('does not add either unlock key to SETTINGS_KEYS', () => {
    const block = SRC.slice(SRC.indexOf('SETTINGS_KEYS = ['), SRC.indexOf('];'));
    expect(block).not.toContain('experimentalUnlocked');
    expect(block).not.toContain('trainingUnlocked');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/training-storage.test.js tests/training-content-wiring.test.js`
Expected: FAIL — `UNLOCK_KEY` is still `'trainingUnlocked'`. (The `training-content-wiring` cases pass already; they are renamed for accuracy, not to drive the change.)

- [ ] **Step 3: Repoint the key**

In `src/training/storage.js`, replace line 6 with:

```js
// The gate is the extension's single hidden-features key. It was
// `trainingUnlocked` until 2026-08-11; any value left under that name in an
// installed profile is orphaned and read by nothing. No migration is needed —
// the only build that ever wrote `trainingUnlocked` wrote `experimentalUnlocked`
// in the same call, so no profile can hold one without the other.
export const UNLOCK_KEY = 'experimentalUnlocked';
```

- [ ] **Step 4: Rewrite the gate comment**

In `src/training/gate.js`, replace lines 1-4 (the comment above the `import`) with:

```js
// The hidden-features gate: `experimentalUnlocked`, the key the popup's 5-click
// version-hash gesture flips and the Console rail reads. It was a separate
// `trainingUnlocked` key until 2026-08-11, kept apart so that unlocking training
// could not also hand a trainee Mr. Fabry's write-enabled Architect implement
// loop. That separation stopped protecting anything the moment Fabry went
// public — implement loop included — because a trainee now has it whether or
// not they ever unlock a thing. One gate, named for what it does.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/training-storage.test.js tests/training-content-wiring.test.js tests/training-quest.test.js`
Expected: PASS. `training-quest.test.js` must stay green untouched — it stubs storage through the gate module, which is exactly why one constant moves the whole content-script surface.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/training/storage.js src/training/gate.js tests/training-storage.test.js tests/training-content-wiring.test.js
```

---

### Task 5: Popup writes one key, with matching copy

**Files:**
- Modify: `src/popup/components/App.jsx:13, 23-25, 210-230`
- Test: `tests/popup-training-gate.test.js:5, 85-149`

**Interfaces:**
- Consumes: `UNLOCK_KEY === 'experimentalUnlocked'` from Task 4 — which is why the import can go: the popup writes the literal key and the training modules read the same one.
- Produces: nothing for later tasks.

Keep the test file's name. It still covers the gate the training quest depends on, and its `describe` already reads "unified unlock gate".

- [ ] **Step 1: Rewrite the failing tests**

In `tests/popup-training-gate.test.js`:

(a) Replace the import on line 5 with a plain constant, so the test asserts the literal key the popup must write rather than following whatever the module exports:

```js
const GATE_KEY = 'experimentalUnlocked';
```

(b) Replace the three tests at lines 86-129 with:

```js
  it('five clicks on the version hash set the ONE gate key, in a single write', async () => {
    await mountApp(UNSITED_TAB, { [GATE_KEY]: false });

    clickVersion(5);
    await waitFor(() => state[GATE_KEY] === true);

    // Exactly one key. Until 2026-08-11 this wrote `trainingUnlocked` alongside
    // it; that key is retired, and writing it again would resurrect a second
    // source of truth for the same gate.
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [GATE_KEY]: true });
    expect(state.trainingUnlocked).toBeUndefined();
    expect(state[GATE_KEY]).toBe(true);
  });

  it('five more clicks set it back to false — it is a toggle', async () => {
    await mountApp(UNSITED_TAB, { [GATE_KEY]: true });

    clickVersion(5);
    await waitFor(() => state[GATE_KEY] === false);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [GATE_KEY]: false });
    expect(state[GATE_KEY]).toBe(false);
  });

  it('shows a notice naming experimental features, distinguishing unlocked from hidden', async () => {
    await mountApp(UNSITED_TAB, { [GATE_KEY]: false });
    expect(document.body.querySelector('.unlock-notice')).toBeNull();

    clickVersion(5);
    await waitFor(() => !!document.body.querySelector('.unlock-notice'));
    const unlockedText = document.body.querySelector('.unlock-notice').textContent;
    expect(unlockedText).toMatch(/unlock/i);
    // One vocabulary from storage key to badge to notice.
    expect(unlockedText).toMatch(/experimental/i);
    // "& training" described the retired two-key era.
    expect(unlockedText).not.toMatch(/training/i);

    clickVersion(5);
    await waitFor(() => document.body.querySelector('.unlock-notice')?.textContent !== unlockedText);
    const hiddenText = document.body.querySelector('.unlock-notice').textContent;
    expect(hiddenText).toMatch(/hid/i);
    expect(hiddenText).not.toBe(unlockedText);
  });
```

(c) In the remaining two tests (the brand-name regression guard at lines 136-148 and the no-popup-entry-point test at line 159), replace every `{ experimentalUnlocked: X, [UNLOCK_KEY]: X }` seed with `{ [GATE_KEY]: X }`, and replace the assertions `expect(state.experimentalUnlocked).toBe(false); expect(state[UNLOCK_KEY]).toBe(false);` with a single `expect(state[GATE_KEY]).toBe(false);`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/popup-training-gate.test.js`
Expected: FAIL — the popup still writes two keys, so `toHaveBeenCalledWith({ experimentalUnlocked: true })` does not match, and the notice still contains "training".

- [ ] **Step 3: Update the popup**

In `src/popup/components/App.jsx`:

(a) Delete the import on line 13 (`import { UNLOCK_KEY } from '../../training/storage.js';`) entirely.

(b) Replace the comment at lines 23-25 with:

```js
  // Not a toggle shown anywhere: the hidden-features gate (5 clicks on the
  // version hash). Loaded with the rest so the click handler can toggle it.
```

(c) Replace lines 210-230 (`onVersionClick` and its comment) with:

```js
  // 5 quick clicks on the version hash flip the extension's one hidden-features
  // gate, mirrored live into the Console via chrome.storage.onChanged — no tab
  // reload needed. It hides exactly one thing today: the Academy, badged EXP on
  // the Console rail and reachable only from there. Mr. Fabry is public and no
  // longer sits behind this. Until 2026-08-11 this wrote a second key,
  // `trainingUnlocked`, in the same call; that key is retired.
  const onVersionClick = async () => {
    if (!unlockCounter.click() || !storageValues) return;
    const next = !storageValues.experimentalUnlocked;
    setStorageValues((prev) => ({ ...prev, experimentalUnlocked: next }));
    // Written straight to storage, never via the worker — same cold-start
    // race as the usage-consent write above.
    await chrome.storage.local.set({ experimentalUnlocked: next });
    if (next) track('sa_popup_experimental_unlock');
    setUnlockNotice(next ? 'Experimental features unlocked' : 'Experimental features hidden');
    setTimeout(() => setUnlockNotice(null), 2500);
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/popup-training-gate.test.js`
Expected: PASS, all five cases.

- [ ] **Step 5: Confirm no source file still writes the retired key**

Run: `grep -rn "trainingUnlocked" src/`
Expected: no output.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/popup/components/App.jsx tests/popup-training-gate.test.js
```

---

### Task 6: Documentation, full suite, and build

**Files:**
- Modify: `CLAUDE.md` (six passages), `PRIVACY.md:89`

**Interfaces:**
- Consumes: the finished behaviour from Tasks 1-5.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update the Console app list**

`CLAUDE.md:28` — replace `Fabry Chat (`src/fabry/`, experimental-gated), and Academy (`src/academy/`, the onboarding training track, gated behind `trainingUnlocked`)` with:

```
Fabry Chat (`src/fabry/`), and Academy (`src/academy/`, the onboarding training track, the one app gated behind `experimentalUnlocked`)
```

- [ ] **Step 2: Replace the training-gate bullet**

`CLAUDE.md:208-225` — replace the entire bullet beginning `- **`trainingUnlocked` is a separate storage key…` (through `…without touching `gate.js` or the Academy.`) with:

```markdown
- **The gate is `experimentalUnlocked`, and it is the only one** (`src/training/
  gate.js` + `src/training/storage.js` `UNLOCK_KEY`; written by
  `src/popup/components/App.jsx` `onVersionClick`): 5 quick clicks on the popup's
  footer version hash, mirrored live into the Console via
  `chrome.storage.onChanged`. It hides exactly one thing — the Academy, badged
  `EXP` on the rail. Training had its own `trainingUnlocked` key from 2026-08-07
  to 2026-08-11, kept separate so a trainee could not acquire Mr. Fabry's
  write-enabled Architect implement loop as a side effect of starting training.
  That reasoning died with the gate on Fabry: Fabry is public for every user,
  implement loop included, so the trainee has it either way and a second key
  protected nothing while giving the same gesture two names. `trainingUnlocked`
  is orphaned — read by nothing, migrated by nothing, and safe to ignore, because
  the only build that ever wrote it wrote `experimentalUnlocked` in the same
  `chrome.storage.local.set` call, so no profile can hold one without the other.
  An even earlier revision gave training a click target of its own — 5 clicks on
  the header extension name (`.brand-name`) — a 68×18px text span with no
  `cursor: pointer` beside a visually-identical non-clickable badge, which no
  real user could find and which silently re-locked on a retry. Removed in
  favour of the single already-known gesture rather than inventing a
  discoverable replacement; `tests/popup-training-gate.test.js` still guards
  that clicking the brand name writes nothing at all.
```

- [ ] **Step 3: Fix the Fabry section opener**

`CLAUDE.md:365-373` — replace the whole paragraph:

```
A Claude-style chat interface over the Rossum Agent API ("Mr. Fabry") — the fifth
Console app, **experimental-gated**: the rail item (label "Fabry", `beta` badge like Inspector/Galaxy)
renders only while `experimentalUnlocked` is set, and the gate is live —
`chrome.storage.onChanged` mirrors the key into a console-store signal;
re-locking while Fabry is active falls back to MDH (an inline gate effect in
`console/index.jsx` using `activeApp.peek()`; `boot.js appAfterGateChange` is
the tested pure equivalent), and
`pickInitialApp` refuses a persisted/staged `fabry` while locked. Spec:
`docs/superpowers/specs/2026-07-10-fabry-chat-console-design.md`.
```

with:

```
A Claude-style chat interface over the Rossum Agent API ("Mr. Fabry") — the fifth
Console app, **public since 2026-08-11**: the rail item (label "Fabry", `beta`
badge like Inspector) renders for every user, with no gate in `Rail.jsx` and no
clause in `boot.js` `pickInitialApp`/`appAfterGateChange`. It rendered only while
`experimentalUnlocked` was set until then; that key now gates the **Academy**
alone, and the live-gate machinery it drives is unchanged and simply serves that
app instead — `chrome.storage.onChanged` mirrors the key into a console-store
signal, and re-locking while the Academy is active falls back to MDH (an inline
gate effect in `console/index.jsx` using `activeApp.peek()`; `boot.js
appAfterGateChange` is the tested pure equivalent). Ungating Fabry was an owner
decision that knowingly made the write-enabled Architect implement loop public
— see that section below. Specs:
`docs/superpowers/specs/2026-07-10-fabry-chat-console-design.md`,
`docs/superpowers/specs/2026-08-11-fabry-public-single-gate-design.md`.
```

- [ ] **Step 4: Fix the two Architect gate claims**

`CLAUDE.md:489` — replace `No new gate — inside the existing `experimentalUnlocked` Fabry app.` with:

```
No new gate — inside the Fabry app, which is public since 2026-08-11.
```

`CLAUDE.md:497-499` — replace `**Double-gated** — `experimentalUnlocked` (the whole Fabry app) + a per-run **Arm** dialog. It is ON by default within the experimental Fabry app` with:

```
**Gated by the per-run Arm dialog alone** since 2026-08-11, when Fabry went
public and took its `experimentalUnlocked` gate with it (owner decision: "fully
public, implement included"). It is ON by default within the Fabry app
```

This one matters most of the six: it describes the safety posture of an autonomous write-to-org loop, and it currently claims a gate that no longer exists.

- [ ] **Step 5: Update the storage-key list**

`CLAUDE.md:685` — replace the `- Experimental unlock:` bullet with:

```markdown
- Hidden-features unlock: `experimentalUnlocked` — flipped by 5 quick clicks on the popup's version hash; the extension's ONE gate, hiding the Academy Console app (live via `chrome.storage.onChanged`). It gated the Fabry Console app until 2026-08-11, when Fabry went public; it was formerly also the second half of the Annotate-for-me double-gate, removed with that feature 2026-07-20. It absorbed the retired `trainingUnlocked` key — see Onboarding training state below.
```

`CLAUDE.md:695` — replace the `- Onboarding training state:` bullet with:

```markdown
- Onboarding training state: `trainingProgress` (per-org-origin progress + any issued receipt, capped at 3 orgs). The gate is the shared `experimentalUnlocked` above; the former `trainingUnlocked` key (2026-08-07 to 2026-08-11) is orphaned, never migrated — no profile can hold it without `experimentalUnlocked`, so nothing was lost.
```

- [ ] **Step 6: Update PRIVACY.md**

`PRIVACY.md:89` — replace `| `sa_popup_experimental_unlock` | you unlocked the experimental section |` with:

```
| `sa_popup_experimental_unlock` | you unlocked the extension's experimental features |
```

The event name itself must not change: renaming it would break the GA4 series and require an edit to the closed vocabulary in `src/usage/event.js`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, whole suite, zero failures. Investigate any failure rather than adjusting the assertion to match — the tests written in Tasks 1-5 encode the intended behaviour.

- [ ] **Step 8: Confirm the retired key is gone from source and docs**

Run: `grep -rn "trainingUnlocked" src/ tests/ CLAUDE.md PRIVACY.md`
Expected: only the deliberate historical mentions — `src/training/storage.js`, `src/training/gate.js`, `tests/popup-training-gate.test.js`, `tests/training-content-wiring.test.js`, and the CLAUDE.md passages above. No live read or write.

- [ ] **Step 9: Rebuild `dist/`**

Run: `npm run build`
Expected: a clean build. Tests exercise `src/`, but the loaded extension runs `dist/` — without this the change is invisible in Chrome.

- [ ] **Step 10: Stage (do NOT commit)**

```bash
git add CLAUDE.md PRIVACY.md
git status
```

Report the staged file list to the owner, tell them to **reload the extension** (and reload any open Rossum tab, since reloading the extension does not re-inject content scripts), and leave the commit to them.

---

## Manual verification (owner, after reload)

1. Open the Console from the popup on a Rossum tab with the gate **locked** (a fresh profile, or 5 clicks to re-hide). The rail shows five apps: Data, Audit, Inspector, **Fabry**, Galaxy. No Academy.
2. Click Fabry — it opens, with a `beta` badge and no unlock needed.
3. Click the version hash 5 times. The notice reads "Experimental features unlocked". Without reloading the Console tab, the Academy appears on the rail with a blue `EXP` badge, tooltip "Onboarding training — experimental".
4. Click the version hash 5 more times: the notice reads "Experimental features hidden", the Academy disappears, and if it was the active app the Console falls back to Dataset Management. Fabry stays put in both states.
5. On a Rossum page with the gate unlocked and a track started, the quest card still appears — confirming the content script follows the same key.
