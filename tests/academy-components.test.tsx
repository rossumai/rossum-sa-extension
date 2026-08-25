// tests/academy-components.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import MissionList from '../src/academy/components/MissionList.jsx';
import MissionDetail from '../src/academy/components/MissionDetail.jsx';
import AcademyApp from '../src/academy/components/App.jsx';
import { noteFor } from '../src/academy/components/ReceiptPanel.jsx';
import * as store from '../src/academy/store.js';
import { TRACK } from '../src/training/track.js';
import { emptyProgress, markStep } from '../src/training/progress.js';
import academyCss from '../src/academy/Academy.module.css';

async function waitFor(cond: any, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The brief's `document.body.innerHTML = ''` alone does not unmount Preact's
// previous tree: Preact keeps its vdom/fiber state on the container node
// itself, so a same-shaped re-render into a manually-wiped `document.body`
// silently reconciles against detached nodes and appends nothing (probed:
// the 2nd `render(<MissionList … />, document.body)` in a row produced an
// EMPTY body, 0 buttons, even though the component works — the 3rd render,
// of a differently-shaped tree, happened to recover, which is what made this
// intermittent-looking rather than an obvious break). `render(null, ...)`
// first properly unmounts so the following render always starts clean.
beforeEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
  store.error.value = null;
  store.mintNote.value = null;
  store.progress.value = null;
  store.receiptText.value = null;
  store.activeMissionId.value = null;
});

describe('MissionList', () => {
  it('lists every mission with its progress fraction', async () => {
    const p = emptyProgress(TRACK, 1);
    render(<MissionList track={TRACK} progress={p} activeId="m1" onSelect={() => {}} />, document.body);
    await waitFor(() => document.body.textContent.includes('Orientation'));
    for (const m of TRACK.missions) expect(document.body.textContent).toContain(m.title);
    expect(document.body.textContent).toContain(`0/${TRACK.missions[0].steps.length}`);
  });

  it('marks later missions locked and does not select them', async () => {
    const p = emptyProgress(TRACK, 1);
    const onSelect = vi.fn();
    render(<MissionList track={TRACK} progress={p} activeId="m1" onSelect={onSelect} />, document.body);
    await waitFor(() => document.querySelectorAll('button').length > 1);
    const locked = [...document.querySelectorAll('button')].find((b) => b.disabled);
    expect(locked).toBeTruthy();
    locked!.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('MissionDetail', () => {
  const mission = TRACK.missions[0];

  it('renders every step with a kind chip', async () => {
    render(<MissionDetail mission={mission} progress={emptyProgress(TRACK, 1)} onAttest={() => {}} />, document.body);
    await waitFor(() => document.body.textContent.includes(mission.steps[0].hint));
    expect(document.body.textContent).toContain('url');
    expect(document.body.textContent).toContain('self');
  });

  it('offers a tick button only on self steps', async () => {
    const onAttest = vi.fn();
    render(<MissionDetail mission={mission} progress={emptyProgress(TRACK, 1)} onAttest={onAttest} />, document.body);
    await waitFor(() => document.querySelectorAll('button').length > 0);
    const buttons = [...document.querySelectorAll('button')];
    expect(buttons).toHaveLength(mission.steps.filter((s) => s.kind === 'self').length);
    buttons[0].click();
    expect(onAttest).toHaveBeenCalledWith(mission.id, mission.steps.find((s) => s.kind === 'self')!.id);
  });

  it('shows a done state for a passed step', async () => {
    const p = markStep(emptyProgress(TRACK, 1), mission.id, mission.steps[0].id, 'passed', 2);
    render(<MissionDetail mission={mission} progress={p} onAttest={() => {}} />, document.body);
    await waitFor(() => document.querySelector('[data-state="passed"]'));
    expect(document.querySelectorAll('[data-state="passed"]')).toHaveLength(1);
  });
});

// I2. store.error was written by store.js and index.jsx and read NOWHERE, so a
// failed write made "I've done this" silently do nothing.
describe('AcademyApp — error strip', () => {
  function completeProgress() {
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      p = { ...p, missions: { ...p.missions, [m.id]: { startedAt: 1, baseline: {}, steps: {} } } };
      for (const s of m.steps) p = markStep(p, m.id, s.id, s.kind === 'self' ? 'self' : 'passed', 2);
    }
    return p;
  }

  it('renders the error in the NOT-CONNECTED branch — initAcademy sets it on exactly that path', async () => {
    store.error.value = "Open the Academy from this extension's popup so it knows which org to track.";
    render(<AcademyApp connected={false} />, document.body);
    await waitFor(() => document.querySelector('[role="alert"]'));
    expect(document.body.textContent).toContain('popup');
  });

  it('renders the error on the start screen, and dismisses it', async () => {
    store.error.value = "Couldn't start the training track: QuotaExceededError";
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.querySelector('[role="alert"]'));
    expect(document.body.textContent).toContain('QuotaExceededError');
    document.querySelector<HTMLElement>('[role="alert"] button')!.click();
    await waitFor(() => document.querySelector('[role="alert"]') === null);
    expect(store.error.value).toBe(null);
  });

  it('renders the error over a started track', async () => {
    store.progress.value = emptyProgress(TRACK, 1);
    store.error.value = "Couldn't save that step: boom";
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.querySelector('[role="alert"]'));
    expect(document.body.textContent).toContain('boom');
  });

  // I3. A failed mint REVOKES the step it failed on, which makes the track
  // incomplete in the same breath — so gating the panel on completeness alone
  // unmounted it, destroying the note that explains what just happened.
  it('keeps the receipt panel mounted while a mint note is pending, even once the track is incomplete', async () => {
    const p = completeProgress();
    // The revocation mint would have written.
    store.progress.value = markStep(p, 'm2', 'm2.s2', null, 3);
    store.mintNote.value = 'Not issued — step m2.s2 no longer checks out in your org, so it has been un-ticked. Redo it and issue again.';
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.body.textContent.includes('Completion receipt'));
    expect(document.body.textContent).toContain('no longer checks out');
    // …and it must not invite a re-issue while the track is incomplete.
    const issue = [...document.querySelectorAll('button')].find((b) => /Issue receipt/.test(b.textContent));
    expect(issue).toBeUndefined();
  });
});

// Not-connected branch — rebuilt on the Console's shared app-root/empty-state
// convention (console.css) instead of the bespoke two-column `css.root` mission
// grid, which squeezed this screen's lone child into the grid's 240px first column.
describe('AcademyApp — not-connected branch', () => {
  it('uses app-root/empty-state, not the two-column mission grid, and keeps the error strip reachable', async () => {
    store.error.value = 'Open the Rossum Console from this extension\'s popup on a Rossum tab to access the Academy.';
    render(<AcademyApp connected={false} />, document.body);
    await waitFor(() => document.querySelector('.empty-state-title'));

    // Not the two-column mission-list grid — a lone child there lands in the
    // grid's first (240px) column instead of using the available width.
    expect(document.querySelector(`.${academyCss.root}`)).toBeNull();

    expect(document.querySelector('.app-root')).toBeTruthy();
    expect(document.querySelector('.empty-state')).toBeTruthy();
    expect(document.querySelector('.empty-state-card')).toBeTruthy();
    expect(document.querySelector('.empty-state-title')!.textContent).toBe('Not connected');

    // initAcademy's only message on this path — must stay reachable.
    expect(document.querySelector('[role="alert"]')).toBeTruthy();
    expect(document.body.textContent).toContain('popup');
  });
});

// Entry ("start the track") screen — the "Aurora" landing hero (owner-picked
// from browser mockups). Not the shared app-root/empty-state convention —
// that stays reserved for the !connected error state below — but still a
// direct app-root child, so the two-column mission grid (`css.root`) must
// never appear here either.
describe('AcademyApp — entry screen (no-progress)', () => {
  it('renders the hero title, lede, and a .btn-primary start button that calls startTrack', async () => {
    store.error.value = 'Something went wrong';
    const startSpy = vi.spyOn(store, 'startTrack').mockImplementation((() => {}) as any);
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.body.textContent.includes(TRACK.title));

    // Not the two-column mission-list grid — a lone child there lands in the
    // grid's first (240px) column instead of using the available width.
    expect(document.querySelector(`.${academyCss.root}`)).toBeNull();
    expect(document.querySelector('.app-root')).toBeTruthy();

    expect(document.querySelector(`.${academyCss.heroTitle}`)!.textContent).toBe(TRACK.title);
    expect(document.querySelector(`.${academyCss.lede}`)).toBeTruthy();
    expect(document.body.textContent).toContain('Learn Rossum by building in it');

    const start = document.querySelector<HTMLElement>('.btn.btn-primary')!;
    expect(start).toBeTruthy();
    expect(start.textContent).toContain('Start the track');
    start.click();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // initAcademy's only message on this path — must stay reachable.
    expect(document.querySelector('[role="alert"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Something went wrong');

    startSpy.mockRestore();
  });

  it('lists one row per mission, each showing its title and TRACK blurb', async () => {
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.body.textContent.includes(TRACK.title));

    const rows = document.querySelectorAll(`.${academyCss.heroMissionRow}`);
    expect(rows).toHaveLength(TRACK.missions.length);
    TRACK.missions.forEach((m, i) => {
      expect(rows[i].textContent).toContain(m.title);
      expect(rows[i].textContent).toContain(m.blurb);
    });
  });

  it('keeps the trainer panel hidden until "Check a colleague\'s receipt" is activated, via a real button', async () => {
    render(<AcademyApp connected />, document.body);
    await waitFor(() => document.body.textContent.includes(TRACK.title));

    // Not rendered up front.
    expect(document.body.textContent).not.toContain('Check a receipt');

    const toggle = [...document.querySelectorAll(`.${academyCss.trainerToggle}`)]
      .find((el) => /Check a colleague.s receipt/.test(el.textContent));
    expect(toggle).toBeTruthy();
    expect(toggle!.tagName).toBe('BUTTON'); // keyboard-accessible, not a div onClick

    (toggle as HTMLElement).click();
    await waitFor(() => document.body.textContent.includes('Check a receipt'));
    expect(document.querySelector(`.${academyCss.trainerWrap}`)).toBeTruthy();
  });
});

// I1 + I3. Each failure gets its own wording: only 'no-longer-true' un-ticks
// anything, so only it may tell the trainee to redo work.
describe('ReceiptPanel — failure wording', () => {
  it('tells an unreachable org apart from work that no longer holds', () => {
    const unreachable = noteFor({ ok: false, reason: 'unreachable', failedStep: 'm4.s2' });
    const stale = noteFor({ ok: false, reason: 'no-longer-true', failedStep: 'm4.s2' });
    expect(unreachable).not.toBe(stale);
    expect(unreachable).toMatch(/couldn't reach/i);
    expect(unreachable).toMatch(/nothing has been un-ticked/i);
    expect(unreachable).not.toMatch(/redo/i);   // the work is fine — do not send them back
    expect(stale).toMatch(/redo/i);
    expect(stale).toMatch(/un-ticked/i);
  });

  it('has honest wording for the identity, unverifiable and unknown-error cases', () => {
    expect(noteFor({ ok: false, reason: 'identity' })).toMatch(/user name and id/i);
    expect(noteFor({ ok: false, reason: 'unverifiable' })).toMatch(/cannot be read back/i);
    expect(noteFor({ ok: false, reason: 'error', message: 'API 401' })).toContain('API 401');
    expect(noteFor({ ok: true, text: 'x' })).toBe(null);
  });

  it('clears busy and shows the note when minting fails — the button never latches on "Checking…"', async () => {
    vi.resetModules();
    // A get that always throws makes mintReceipt return {reason:'unreachable'}.
    vi.doMock('../src/academy/api.js', () => ({
      fetchAcademyApi: async () => { throw new Error('API 401'); },
      whoami: async () => ({ id: 42, username: 'j.doe' }),
    }));
    const Panel = (await import('../src/academy/components/ReceiptPanel.jsx')).default;
    const freshStore = await import('../src/academy/store.js');
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      p = { ...p, missions: { ...p.missions, [m.id]: { startedAt: 1, baseline: {}, steps: {} } } };
      for (const s of m.steps) p = markStep(p, m.id, s.id, s.kind === 'self' ? 'self' : 'passed', 2);
    }
    freshStore.progress.value = p;
    freshStore.receiptText.value = null;
    freshStore.mintNote.value = null;
    freshStore.setOrigin('https://x.rossum.app');

    render(<Panel />, document.body);
    await waitFor(() => document.querySelector('button'));
    document.querySelector('button')!.click();
    await waitFor(() => /Not issued/.test(document.body.textContent));
    const btn = [...document.querySelectorAll('button')].find((b) => /Issue receipt|Checking/.test(b.textContent))!;
    expect(btn.textContent).toContain('Issue receipt'); // not stuck on "Checking…"
    expect(btn.disabled).toBe(false);
    vi.doUnmock('../src/academy/api.js');
  });
});
