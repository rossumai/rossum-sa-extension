// tests/training-quest.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRACK } from '../src/training/track.js';
import { emptyProgress, markStep } from '../src/training/progress.js';
import { PROGRESS_KEY, UNLOCK_KEY } from '../src/training/storage.js';

async function waitFor(cond, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Each test gets its own module instance: training-quest.js keeps deliberate
// module-level state (started / gateListenerOn / intervalHandle) that must
// survive for the page's lifetime in production, so sharing one import across
// tests leaks that state between them.
async function loadQuest() {
  vi.resetModules();
  return import('../src/rossum/features/training-quest.js');
}

let state;
// The listeners chrome.storage.onChanged collected during THIS test. Several
// modules register one (usage/track.js follows consent live), so this is a
// delivery channel, not a count to assert on.
let storageListeners = [];

// Simulate chrome delivering a trainingProgress change — what happens when the
// OTHER surface (the Academy) writes the same per-origin record, and equally
// when this loop writes it itself.
function emitProgressChange(newValue) {
  for (const fn of [...storageListeners]) fn({ [PROGRESS_KEY]: { newValue } }, 'local');
}

beforeEach(() => {
  state = {};
  storageListeners = [];
  document.body.innerHTML = '';
  // The dismiss test writes the DISMISS_KEY to the real (module-level, not
  // mocked) window.sessionStorage, and nothing else in this file clears it.
  // jsdom keeps one window per test FILE, not per test, so that write
  // otherwise survives into every later test — including any that (like this
  // one) dispatches a real 'focus' event, which reawakens the tick() closures
  // still leaked on `window` from every earlier init() call in this file and
  // sends every one of them, including this test's own, down the
  // "dismissed" short-circuit before it ever reaches baseline logic.
  window.sessionStorage.clear();
  globalThis.chrome = { storage: {
    local: {
      get: vi.fn(async (keys) => {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in state) out[k] = state[k];
        return out;
      }),
      set: vi.fn(async (obj) => Object.assign(state, obj)),
    },
    onChanged: { addListener: vi.fn((fn) => storageListeners.push(fn)), removeListener: vi.fn() },
  } };
});

const deps = (over = {}) => ({
  getLocation: () => ({ pathname: '/documents', search: '?level=all' }),
  get: vi.fn(async () => ({ results: [] })),
  now: () => 1000,
  intervalMs: 0,
  ...over,
});

// Placed FIRST and deliberately self-contained: every other describe block in
// this file leaves at least one real, un-removed `window` 'focus' listener
// behind from its own init() call (see the beforeEach comment above on jsdom
// sharing one window per FILE) — some of those tests intentionally never
// dismiss, so — pre-fix or post-fix — they were never going to clean up after
// themselves. Running this test later would have every one of those stale
// listeners fire alongside this test's own on a single dispatchEvent('focus')
// once DISMISS_KEY is set (dismissal is read from real, shared
// window.sessionStorage), inflating the remove count for reasons unrelated to
// the fix under test. Running first — before any other test's init() has run
// — is what keeps the count in this test meaningfully about training-quest.js
// only, not a running tally of the whole file. This test cleans up completely
// (asserts focusAdds() === focusRemoves() at the end of both cycles), so it
// leaves nothing behind for the tests that follow it either.
describe('focus listener cleanup', () => {
  it('does not accumulate window "focus" listeners across a dismiss -> re-unlock cycle', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    const d = deps({ intervalMs: 50 }); // a real interval, like the dismiss test below

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const focusAdds = () => addSpy.mock.calls.filter((c) => c[0] === 'focus').length;
    const focusRemoves = () => removeSpy.mock.calls.filter((c) => c[0] === 'focus').length;

    // Cycle 1: init, dismiss, then a real tick (via the focus listener init()
    // just registered) drives the dismissed branch, which calls stop().
    await init(d);
    await waitFor(() => document.getElementById(CARD_ID));
    document.querySelector(`#${CARD_ID} .rossum-sa-extension-tq-close`).click();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => focusRemoves() === 1);
    expect(focusAdds()).toBe(1);

    // Re-unlock: the dismissal is session-scoped, so clearing it and calling
    // init() again is exactly what onUnlockChange does on a lock->unlock flip
    // once `started` has been reset by stop().
    window.sessionStorage.removeItem('rossum-sa-extension-training-dismissed');
    await init(d);
    await waitFor(() => document.getElementById(CARD_ID));
    document.querySelector(`#${CARD_ID} .rossum-sa-extension-tq-close`).click();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => focusRemoves() === 2);

    // Every add from this second cycle must be matched by its own remove —
    // without the fix, focusRemoves() stays 0 forever and this fails.
    expect(focusAdds()).toBe(2);
    expect(focusRemoves()).toBe(2);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe('production wiring', () => {
  it('forwards the check options to the real fetcher (POST/Bearer must survive)', async () => {
    const fetchRossumApiFresh = vi.fn(async () => ({ results: [] }));
    vi.doMock('../src/rossum/api.js', () => ({ fetchRossumApiFresh }));
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    // Start on the mission whose first unfinished step is API-kind so a check runs.
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      for (const s of m.steps) {
        if (m.id === 'm1' || (m.id === 'm2' && s.kind !== 'api')) p = markStep(p, m.id, s.id, 'passed', 2);
      }
    }
    state[PROGRESS_KEY] = { [window.location.origin]: p };
    await init({ getLocation: () => ({ pathname: '/nowhere', search: '' }), now: () => 1000, intervalMs: 0 });
    await waitFor(() => fetchRossumApiFresh.mock.calls.length > 0);
    const [, opts] = fetchRossumApiFresh.mock.calls[0];
    expect(opts).toBeDefined();          // the second argument must survive
    expect(opts.id).toBeTruthy();        // it is the check object
    vi.doUnmock('../src/rossum/api.js');
  });
});

describe('gate', () => {
  it('injects nothing while locked', async () => {
    const { init, CARD_ID } = await loadQuest();
    await init(deps());
    expect(document.getElementById(CARD_ID)).toBe(null);
  });

  it('never fetches while locked', async () => {
    const { init } = await loadQuest();
    const d = deps();
    await init(d);
    expect(d.get).not.toHaveBeenCalled();
  });
});

describe('card', () => {
  beforeEach(() => { state[UNLOCK_KEY] = true; });

  it('injects the card when unlocked and a track is started', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps());
    await waitFor(() => document.getElementById(CARD_ID));
    expect(document.getElementById(CARD_ID).textContent).toContain('Orientation');
  });

  it('uses no innerHTML anywhere in the card', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps());
    await waitFor(() => document.getElementById(CARD_ID));
    // A hint containing markup characters must land as text, never as elements.
    expect(document.getElementById(CARD_ID).querySelector('script')).toBe(null);
  });

  it('marks a visit step passed when the route matches', async () => {
    const { init } = await loadQuest();
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps());
    await waitFor(() => state[PROGRESS_KEY][window.location.origin].missions?.m1?.steps?.['m1.s1']);
    expect(state[PROGRESS_KEY][window.location.origin].missions.m1.steps['m1.s1'].state).toBe('passed');
  });

  it('does not mark a visit step when the route does not match', async () => {
    const { init } = await loadQuest();
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps({ getLocation: () => ({ pathname: '/nowhere', search: '' }) }));
    // intervalMs:0 means all work is flushed by the time init() resolves —
    // no sleep needed, and a fixed-timeout wait would be a repo-rule violation.
    expect(state[PROGRESS_KEY][window.location.origin].missions?.m1?.steps?.['m1.s1']).toBeUndefined();
  });

  // Drives a REAL tick after dismissal, via the focus listener. An earlier
  // version of this test called init() a second time, which proved nothing:
  // `if (started) return` makes a second init inert whether or not the card was
  // ever dismissed, so it passed for the wrong reason. The observable proof
  // that the dismissed path ran is stop() clearing the interval.
  it('a tick after dismissal renders nothing, stops the loop and makes no API call', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    const d = deps({ intervalMs: 50 }); // a real interval, so stop() has one to clear
    await init(d);
    await waitFor(() => document.getElementById(CARD_ID));

    document.querySelector(`#${CARD_ID} .rossum-sa-extension-tq-close`).click();
    expect(document.getElementById(CARD_ID)).toBe(null);
    const callsAtDismiss = d.get.mock.calls.length;

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    window.dispatchEvent(new Event('focus')); // the listener init() registered runs tick()
    await waitFor(() => clearSpy.mock.calls.length > 0); // the dismissed branch really ran

    expect(document.getElementById(CARD_ID)).toBe(null);
    expect(d.get.mock.calls.length).toBe(callsAtDismiss); // no polling after dismissal
    clearSpy.mockRestore();
  });
});

describe('baseline capture', () => {
  it('does not persist a partial baseline on a failed check, and recovers on a later tick', async () => {
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    // Land on a mission whose first unfinished step is api-kind.
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      for (const s of m.steps) {
        if (m.id === 'm1' || (m.id === 'm2' && s.kind !== 'api')) p = markStep(p, m.id, s.id, 'passed', 2);
      }
    }
    state[PROGRESS_KEY] = { [window.location.origin]: p };

    let failing = true;
    const get = vi.fn(async () => { if (failing) throw new Error('network'); return { results: [] }; });
    await init(deps({ get }));

    // A half-captured baseline is PERMANENT — evaluateApi returns false forever
    // for a check with no entry — so nothing may be persisted on failure.
    // The fixture itself starts the mission's baseline at `null` (markStep's
    // default), so the real assertion is "still null or absent" — mirroring
    // the source's own `baseline == null` gate — not the stricter
    // `toBeUndefined()`, which a bare `null` would already fail regardless
    // of the fix under test.
    const origin = window.location.origin;
    expect(state[PROGRESS_KEY][origin].missions?.m2?.baseline ?? null).toBeNull();

    // A later tick with a working network must capture it (no permanent strand).
    failing = false;
    window.dispatchEvent(new Event('focus')); // drives a real tick via init's listener
    await waitFor(() => state[PROGRESS_KEY][origin].missions?.m2?.baseline !== undefined
      && state[PROGRESS_KEY][origin].missions?.m2?.baseline !== null);
  });
});

describe('nextStep', () => {
  it('returns the first unfinished step of the active mission', async () => {
    const { nextStep } = await loadQuest();
    const p = emptyProgress(TRACK, 1);
    expect(nextStep(TRACK, p).step.id).toBe('m1.s1');
    const p2 = markStep(p, 'm1', 'm1.s1', 'passed', 2);
    expect(nextStep(TRACK, p2).step.id).toBe('m1.s2');
  });

  it('returns null when the whole track is done', async () => {
    const { nextStep } = await loadQuest();
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) for (const s of m.steps) p = markStep(p, m.id, s.id, 'passed', 3);
    expect(nextStep(TRACK, p)).toBe(null);
  });
});

describe('mission complete tracking', () => {
  // `m3` is the one real mission in `src/training/track.js` whose LAST step
  // (`m3.s5`) is `visit`-kind — evaluated by THIS content script, never by
  // the Academy's `attestStep` (which only ever completes a mission via a
  // `self` step). Fixture: m1 and m2 fully done (so m3 is the active
  // mission), every m3 step but m3.s5 already done, with an explicit
  // non-null baseline so tick() doesn't try to capture one live over the
  // network for a mission we're not testing baseline capture on.
  function almostDoneAtM3() {
    let p = emptyProgress(TRACK, 1);
    // Only the two missions BEFORE m3 — leaving m4/m5 untouched. An earlier
    // draft of this fixture looped "every mission except m3", which also
    // finished m4 and m5 up front: with the whole track already done, the
    // second tick had nothing left to do (no baseline to capture, 0 `get()`
    // calls ever), and the double-fire test below hung forever waiting on a
    // signal that could never arrive.
    for (const id of ['m1', 'm2']) {
      const m = TRACK.missions.find((x) => x.id === id);
      for (const s of m.steps) p = markStep(p, id, s.id, s.kind === 'self' ? 'self' : 'passed', 2);
    }
    p = { ...p, missions: { ...p.missions, m3: { startedAt: 1, baseline: {}, steps: {} } } };
    for (const s of TRACK.missions.find((m) => m.id === 'm3').steps) {
      if (s.id === 'm3.s5') continue;
      p = markStep(p, 'm3', s.id, s.kind === 'self' ? 'self' : 'passed', 2);
    }
    return p;
  }

  function stubUsage() {
    const sent = [];
    globalThis.chrome.runtime = { sendMessage: vi.fn((m) => { sent.push(m); return Promise.resolve(); }) };
    return sent;
  }

  beforeEach(() => {
    // track.js's module-level side effect resolves consent from
    // chrome.storage.local.get(['usageConsent']) asynchronously; without an
    // explicit true here it settles to `false` (nothing in `state`) and
    // every track() call after that race silently no-ops. Setting it before
    // loadQuest() re-imports track.js means the resolution lands on `true`.
    state.usageConsent = true;
  });

  it('fires sa_training_mission_complete when a visit step completes a mission', async () => {
    const sent = stubUsage();
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: almostDoneAtM3() };

    await init(deps({ getLocation: () => ({ pathname: '/queues/1', search: '' }) }));
    await waitFor(() => state[PROGRESS_KEY][window.location.origin].missions.m3.steps['m3.s5']);

    expect(sent.map((m) => m.name)).toContain('sa_training_mission_complete');
  });

  it('does not double-fire on a later tick once the mission is already complete', async () => {
    const sent = stubUsage();
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: almostDoneAtM3() };
    const d = deps({ getLocation: () => ({ pathname: '/queues/1', search: '' }), intervalMs: 0 });

    await init(d);
    await waitFor(() => state[PROGRESS_KEY][window.location.origin].missions.m3.steps['m3.s5']);
    const countAfterFirstTick = sent.filter((m) => m.name === 'sa_training_mission_complete').length;
    expect(countAfterFirstTick).toBe(1);

    // Drive a real second tick via the focus listener init() registered (the
    // same mechanism the rest of this file uses for "a later tick"). m3 is
    // already complete, so nextStep() has moved on to m4 — proven by waiting
    // for the get calls m4's baseline capture makes, rather than a timeout.
    const getCallsBeforeSecondTick = d.get.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => d.get.mock.calls.length > getCallsBeforeSecondTick);

    expect(sent.filter((m) => m.name === 'sa_training_mission_complete').length).toBe(1);
  });
});

// C1. The intended FIRST run: unlock in the popup (no tab reload), open the
// Academy in a Console tab, click "Start the track", switch back to the Rossum
// tab. init() has long since returned at the "no track yet" bail-out by then.
// Nothing else in the extension can mark a `visit` or `api` step, so without a
// progress watcher the trainee sits at 0/4 with no card and no explanation.
describe('track started while the page is already open (C1)', () => {
  it('starts the loop and renders the card when a track appears in storage', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true; // unlocked, but NO progress record yet
    const d = deps();
    await init(d);
    expect(document.getElementById(CARD_ID)).toBe(null); // nothing to show yet

    // The Academy writes the record from another tab.
    const fresh = { [window.location.origin]: emptyProgress(TRACK, 1) };
    state[PROGRESS_KEY] = fresh;
    emitProgressChange(fresh);

    await waitFor(() => document.getElementById(CARD_ID));
    expect(document.getElementById(CARD_ID).textContent).toContain('Orientation');
  });

  it('does not stack loops when the record changes repeatedly', async () => {
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 999);
    await init(deps({ intervalMs: 1500 }));

    const fresh = { [window.location.origin]: emptyProgress(TRACK, 1) };
    state[PROGRESS_KEY] = fresh;
    emitProgressChange(fresh);
    emitProgressChange(fresh);
    emitProgressChange(fresh);

    await waitFor(() => setIntervalSpy.mock.calls.length > 0);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  // A REGRESSION GUARD, not a bug fix — see the report. The re-review expected
  // the pre-sentinel guard (`if (started) return; started = true;` after a
  // single `await isUnlocked()`) to admit two loops; it cannot. Those two
  // statements are adjacent and synchronous, so whichever continuation resumes
  // first claims the loop, whatever order the storage reads resolve in
  // (probed with 0/0, 5/1, 1/5 and 0/3 ms interleavings — always one loop).
  // What the synchronous `starting` sentinel buys is that the invariant no
  // longer depends on there being exactly ONE await before the commit point:
  // adding a second one above it would silently reintroduce the race the
  // reviewer described. This test pins concurrent init() calls to one loop
  // regardless, with storage taking a real macrotask turn so the calls really
  // do interleave (the mock the rest of this file uses resolves synchronously).
  it('concurrent init() calls start exactly ONE loop, even with slow storage', async () => {
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    const syncGet = globalThis.chrome.storage.local.get;
    let turn = 0;
    globalThis.chrome.storage.local.get = vi.fn(async (keys) => {
      // Alternating delays, so the reads also resolve OUT OF ORDER.
      await new Promise((r) => setTimeout(r, (turn++ % 2) ? 1 : 5));
      return syncGet(keys);
    });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 999);

    // Deliberately NOT awaited in turn: this is two listener callbacks firing
    // back to back, neither of which can await the other.
    await Promise.all([init(deps({ intervalMs: 1500 })), init(deps({ intervalMs: 1500 }))]);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
    globalThis.chrome.storage.local.get = syncGet;
  });

  it('registers exactly one progress listener however many times init runs', async () => {
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    const before = storageListeners.length;
    await init(deps());
    await init(deps());
    await init(deps());
    expect(storageListeners.length - before).toBe(1);
  });
});

// C2. The loop held progress in a closure it never refreshed while save() wrote
// that whole closure back, replacing the per-origin record the Academy owns too.
describe('progress written by the Academy (C2)', () => {
  // Every mission but m3 ENDS on a `self` step, which only the Academy can
  // mark. Without a refresh the card's nextStep keeps returning the step that
  // was just attested, and the trainee is stuck there until a page reload.
  it('advances past a step the Academy attested, with no reload', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    // m1.s1..s3 done; m1.s4 is `self` and is the step the card is showing.
    let p = emptyProgress(TRACK, 1);
    for (const s of TRACK.missions[0].steps) {
      if (s.kind !== 'self') p = markStep(p, 'm1', s.id, 'passed', 2);
    }
    state[PROGRESS_KEY] = { [window.location.origin]: p };
    await init(deps({ getLocation: () => ({ pathname: '/nowhere', search: '' }), intervalMs: 50 }));
    await waitFor(() => document.getElementById(CARD_ID));
    expect(document.getElementById(CARD_ID).textContent).toContain('Orientation');

    // The Academy attests m1.s4 — mission 1 is now complete.
    const attested = markStep(p, 'm1', 'm1.s4', 'self', 3);
    const next = { [window.location.origin]: attested };
    state[PROGRESS_KEY] = next;
    emitProgressChange(next);

    // The card must move to mission 2 on its own.
    await waitFor(() => document.getElementById(CARD_ID)?.textContent.includes('Queues & schema'));
  });

  // "Restart track" clears the record. The loop's next write used to hand the
  // entire old progress straight back.
  it('never resurrects progress the trainee cleared with Restart track', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    let p = emptyProgress(TRACK, 1);
    for (const s of TRACK.missions[0].steps) {
      if (s.kind !== 'self') p = markStep(p, 'm1', s.id, 'passed', 2);
    }
    state[PROGRESS_KEY] = { [window.location.origin]: p };
    // A route that WOULD mark m1.s1 — so the loop has a reason to write.
    await init(deps({ intervalMs: 50 }));
    await waitFor(() => document.getElementById(CARD_ID));

    state[PROGRESS_KEY] = {}; // restartTrack -> clearProgress
    emitProgressChange({});

    await waitFor(() => document.getElementById(CARD_ID) === null);
    // Give the interval several chances to write the stale closure back.
    await new Promise((r) => setTimeout(r, 200));
    expect(state[PROGRESS_KEY][window.location.origin]).toBeUndefined();
  });

  // A tick suspended on the network when the restart arrives resumes PAST
  // stop(). Rendering there leaves a card that no interval will ever refresh —
  // frozen on a step of a track that no longer exists.
  it('a tick suspended on a fetch does not render a zombie card after a restart', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    const origin = window.location.origin;
    // m2.s2 (api) is the active step, with a baseline no response can beat, so
    // the tick reaches the bottom render with nothing else to do.
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      for (const s of m.steps) {
        if (m.id === 'm1' || (m.id === 'm2' && s.kind !== 'api')) p = markStep(p, m.id, s.id, 'passed', 2);
      }
    }
    p = { ...p, missions: { ...p.missions, m2: { ...p.missions.m2, baseline: { schemaFieldAdded: 999 } } } };
    state[PROGRESS_KEY] = { [origin]: p };

    // The restart lands WHILE this fetch is in flight — the whole point.
    const get = vi.fn(async () => {
      state[PROGRESS_KEY] = {};
      emitProgressChange({});
      return { results: [] }; // 0 fields: never beats the 999 baseline
    });
    // A real clock, so the api branch clears its 20s throttle on the first tick.
    await init(deps({ get, now: () => Date.now(), intervalMs: 0 }));

    expect(get).toHaveBeenCalled();                      // the tick really did suspend
    expect(document.getElementById(CARD_ID)).toBe(null); // and rendered nothing after
  });

  // stop() closes over MODULE-level `intervalHandle`, so a dead loop's stop()
  // would clear whatever interval is installed at the time — including a
  // successor's.
  it('a restart delivered mid-fetch leaves the successor loop with a live interval', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    const origin = window.location.origin;
    const INTERVAL = 23; // distinctive, so unrelated timers are filtered out
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      for (const s of m.steps) {
        if (m.id === 'm1' || (m.id === 'm2' && s.kind !== 'api')) p = markStep(p, m.id, s.id, 'passed', 2);
      }
    }
    state[PROGRESS_KEY] = { [origin]: p };

    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    let call = 0;
    const get = vi.fn(async () => {
      call += 1;
      // Tick 1 fails its baseline capture, so loop A returns early and init()
      // goes on to install interval A — which is what this test needs to exist
      // before the restart arrives.
      if (call === 1) throw new Error('network');
      if (call === 2) {
        state[PROGRESS_KEY] = {};                                 // Restart track…
        emitProgressChange({});                                   // …stops loop A
        state[PROGRESS_KEY] = { [origin]: emptyProgress(TRACK, 9) };
        emitProgressChange(state[PROGRESS_KEY]);                  // …and starts loop B
      }
      return { results: [] };
    });

    await init(deps({ get, intervalMs: INTERVAL }));
    // Interval A drives tick 2, which is the one that gets restarted from under it.
    await waitFor(() => get.mock.calls.length >= 2);
    // Loop B took over: a brand-new track, so the card is back on mission 1.
    await waitFor(() => document.getElementById(CARD_ID)?.textContent.includes('Orientation'));

    const ours = setSpy.mock.calls
      .map((c, i) => ({ delay: c[1], handle: setSpy.mock.results[i].value }))
      .filter((x) => x.delay === INTERVAL);
    expect(ours.length).toBe(2); // A, then B
    const cleared = clearSpy.mock.calls.map((c) => c[0]);
    expect(cleared).toContain(ours[0].handle);     // A's interval was torn down
    expect(cleared).not.toContain(ours[1].handle); // B's was NOT
    for (const x of ours) globalThis.clearInterval(x.handle);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  // The read-modify-write half of the fix: a write must merge onto whatever is
  // in storage NOW, not onto the closure's snapshot.
  it('a step marked here does not clobber an attestation made while the tick ran', async () => {
    const { init } = await loadQuest();
    state[UNLOCK_KEY] = true;
    const origin = window.location.origin;
    const base = emptyProgress(TRACK, 1);
    state[PROGRESS_KEY] = { [origin]: base };

    // Land the Academy's attestation in storage AFTER init() read progress but
    // before the tick writes — without ever delivering the onChanged event, so
    // only the re-read can save it.
    let armed = false;
    const getLocation = () => {
      if (!armed) {
        armed = true;
        state[PROGRESS_KEY] = { [origin]: markStep(base, 'm1', 'm1.s4', 'self', 3) };
      }
      return { pathname: '/documents', search: '?level=all' };
    };
    await init(deps({ getLocation, intervalMs: 0 }));

    const stored = state[PROGRESS_KEY][origin];
    expect(stored.missions.m1.steps['m1.s1'].state).toBe('passed'); // this loop's write landed
    expect(stored.missions.m1.steps['m1.s4'].state).toBe('self');   // and did not eat the attestation
  });
});

describe('unlock re-entry', () => {
  it('does not stack a second tick loop when the gate listener fires twice', async () => {
    // `loadQuest()` re-imports `../../usage/track.js` too (training-quest.js
    // now calls `track()` for `sa_training_mission_complete`), and THAT
    // module registers its own chrome.storage.onChanged listener as a
    // module-level side effect (to follow live consent changes) — on the
    // very same mock this test uses. Snapshotting the call count right after
    // import, before init(), keeps this test about the gate's OWN listener
    // regardless of what an unrelated import already registered.
    const { init } = await loadQuest();
    const addListener = globalThis.chrome.storage.onChanged.addListener;
    const callsBeforeInit = addListener.mock.calls.length;
    // Locked: init() registers exactly one chrome.storage.onChanged listener
    // and returns, without touching `started`.
    await init(deps({ intervalMs: 1500 }));
    expect(addListener.mock.calls.length - callsBeforeInit).toBe(1);
    const listener = addListener.mock.calls.at(-1)[0];

    // Unlock, and give init() something to actually start a loop over.
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    // Prevent a REAL interval from surviving past this test (intervalMs is
    // non-zero on purpose, per the coordinator's ask) while still recording calls.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 999);

    // Simulate chrome.storage.onChanged firing twice in a row for the same
    // flip to true — e.g. a redundant event, or the trainee's popup click
    // landing twice. Each call re-enters init(deps) via onUnlockChange's cb.
    listener({ [UNLOCK_KEY]: { newValue: true } }, 'local');
    listener({ [UNLOCK_KEY]: { newValue: true } }, 'local');

    await waitFor(() => setIntervalSpy.mock.calls.length > 0);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBeGreaterThan(0);
    setIntervalSpy.mockRestore();
  });
});
