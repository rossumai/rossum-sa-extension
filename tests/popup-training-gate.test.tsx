// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import App from '../src/popup/components/App.jsx';

const GATE_KEY = 'experimentalUnlocked';

async function waitFor(cond: any, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let state: any;
beforeEach(() => {
  state = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...state })),
        set: vi.fn(async (obj) => Object.assign(state, obj)),
      },
      // Only exercised by the Rossum-tab guard test below (the MDH provenance
      // panel's caches) — harmless to the site-less tests above, which never
      // render that panel.
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    } as any,
    tabs: { query: vi.fn(async () => []) },
    runtime: {
      getManifest: () => ({ version: '1.0', version_name: 'test' }),
      getURL: (p: any) => `chrome-extension://test-id/${p}`,
      sendMessage: vi.fn(),
    },
    // Token-less context: on the Rossum tab below, readAuthInfo/readPageFlag/
    // readCurrentContext all resolve via this one generic stub with no network.
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            token: null,
            domain: 'https://org.rossum.app',
            annotationId: null,
            queueId: null,
          },
        },
      ]),
    },
  } as any;
  document.body.innerHTML = '';
});

afterEach(() => {
  // Unmount before the next test's beforeEach clears the DOM out from under
  // preact, per repo convention for tests that render into document.body.
  render(null, document.body);
});

// Integration tests against the real popup App. The version-hash easter egg
// is the extension's ONE hidden-features gate: it writes `experimentalUnlocked`
// and nothing else, and what it hides today is the Academy. Mr. Fabry used to
// sit behind the same key and is now public. A tab with no recognized site
// keeps the render tree minimal (no MDH panel, no reviewing-lock banner) while
// still exercising the header, the version-hash click target, and the footer
// notice.
const UNSITED_TAB = { id: 1, url: 'https://example.com/' };

async function mountApp(tab: any, seed: any) {
  // Pre-answer the usage-consent ask (`usageAsked: true`) so App's unrelated
  // ask-overlay effect never fires — that effect calls the SAME
  // chrome.storage.local.set mock asynchronously (after mount), which would
  // otherwise leak an extra `{ usageAsked: true }` write into assertions
  // below, including the exact-call-count check in the brand-name test.
  Object.assign(state, { usageAsked: true }, seed);
  render(<App tab={tab} />, document.body);
  await waitFor(() => document.body.querySelector('.brand-name'));
}

function clickVersion(times: any) {
  const el = document.body.querySelector<HTMLElement>('.version');
  for (let i = 0; i < times; i++) el!.click();
}

function clickBrandName(times: any) {
  const el = document.body.querySelector<HTMLElement>('.brand-name');
  for (let i = 0; i < times; i++) el!.click();
}

describe('unified unlock gate — popup App integration', () => {
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
    const unlockedText = document.body.querySelector('.unlock-notice')!.textContent;
    expect(unlockedText).toMatch(/unlock/i);
    // One vocabulary from storage key to badge to notice.
    expect(unlockedText).toMatch(/experimental/i);
    // "& training" described the retired two-key era.
    expect(unlockedText).not.toMatch(/training/i);

    clickVersion(5);
    await waitFor(
      () => document.body.querySelector('.unlock-notice')?.textContent !== unlockedText,
    );
    const hiddenText = document.body.querySelector('.unlock-notice')!.textContent;
    expect(hiddenText).toMatch(/hid/i);
    expect(hiddenText).not.toBe(unlockedText);
  });

  // Regression guard for the removed second easter egg: 5 clicks on the
  // extension name used to flip trainingUnlocked on its own (a 68x18px text
  // span with no cursor:pointer that a real user could never find). The
  // brand name is now a plain, inert label — clicking it must do nothing at
  // all, not even a partial/failed attempt at a write.
  it('clicking the brand name does nothing — no storage write at all', async () => {
    await mountApp(UNSITED_TAB, { [GATE_KEY]: false });
    vi.mocked(chrome.storage.local.set).mockClear();

    clickBrandName(5);
    // Give any stray microtask a chance to run before asserting silence.
    await new Promise((r) => setTimeout(r, 20));

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(state[GATE_KEY]).toBe(false);
    expect(document.body.querySelector('.unlock-notice')).toBeNull();
  });
});

// Owner decision: the Academy is reachable from the Console rail only. The
// popup used to offer its own "Open the Academy" button (TrainingSection,
// removed above) whenever trainingUnlocked was set — that entry point is
// gone, and this guards against it quietly coming back.
const ROSSUM_TAB = { id: 2, url: 'https://org.rossum.app/document/5' };

describe('no popup entry point to the Academy', () => {
  it('renders no "Open the Academy" affordance on a Rossum tab, even when unlocked', async () => {
    await mountApp(ROSSUM_TAB, { [GATE_KEY]: true });
    // Give the MDH provenance panel's token-less settle a chance to run so the
    // render tree is fully populated before asserting absence.
    await waitFor(() => document.body.querySelector('#mainContent'));

    expect(document.body.textContent).not.toMatch(/Open the Academy/);
    expect(document.body.querySelector('.section')).toBeNull();
    expect(document.body.querySelector('.link-button')).toBeNull();
  });
});
