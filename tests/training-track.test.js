import { describe, it, expect } from 'vitest';
import { TRACK } from '../src/training/track.js';
import { checkIds } from '../src/training/steps.js';
import { detectResource, ROUTES } from '../src/devtools/detect.js';

const steps = TRACK.missions.flatMap((m) => m.steps);

describe('curriculum integrity', () => {
  it('has a stable id and an integer version', () => {
    expect(TRACK.id).toBe('partner-foundations');
    expect(Number.isInteger(TRACK.version)).toBe(true);
  });

  it('gives every mission and step a unique id', () => {
    const missionIds = TRACK.missions.map((m) => m.id);
    expect(new Set(missionIds).size).toBe(missionIds.length);
    const stepIds = steps.map((s) => s.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  it('prefixes every step id with its mission id', () => {
    for (const m of TRACK.missions) {
      for (const s of m.steps) expect(s.id.startsWith(`${m.id}.`)).toBe(true);
    }
  });

  it('uses only known step kinds', () => {
    for (const s of steps) expect(['visit', 'api', 'self']).toContain(s.kind);
  });

  it('points every api step at a check that exists', () => {
    for (const s of steps.filter((x) => x.kind === 'api')) {
      expect(checkIds()).toContain(s.check);
    }
  });

  it('points every visit step at a type detectResource can actually return', () => {
    const known = new Set([...ROUTES.map((r) => r.type), 'organization', 'label', 'inbox', 'schema']);
    for (const s of steps.filter((x) => x.kind === 'visit')) {
      expect(known).toContain(s.target.type);
    }
  });

  it('gives every step a one-line plain hint and markdown teaching text', () => {
    for (const s of steps) {
      expect(typeof s.hint).toBe('string');
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.hint).not.toContain('\n');   // the card renders one line
      expect(s.hint).not.toContain('<');    // textContent only, never markup
      expect(typeof s.teach).toBe('string');
      expect(s.teach.length).toBeGreaterThan(0);
    }
  });

  it('anchors by href only — never by CSS class or id selector', () => {
    for (const s of steps.filter((x) => x.anchor)) {
      expect(Object.keys(s.anchor)).toEqual(['hrefIncludes']);
      expect(typeof s.anchor.hrefIncludes).toBe('string');
    }
  });

  it('checks visit steps against what detectResource can actually return: detail:true must name a type ROUTES captures with an id; detail:false must name a type resolvable without one', () => {
    // Every ROUTES row's regex captures an id (see src/devtools/detect.js) — so
    // any type listed there is safe for a step that claims `detail: true`.
    const detailCapable = new Set(ROUTES.map((r) => r.type));
    // Types detectResource can resolve WITHOUT an id, per src/devtools/detect.js:
    //   hook, user, label — the read-only collection-list branches (e.g.
    //     /extensions/my-extensions, /settings/users, /settings/labels)
    //   organization       — /documents?level=all (`via: 'org'`)
    //   schema             — the queue "Fields" tab (`via: 'queue'`, unresolved
    //     until the queue.schema fetch)
    //   inbox              — the queue "Emails" tab (`via: 'queue-inbox'`)
    const idLessCapable = new Set(['hook', 'user', 'label', 'organization', 'schema', 'inbox']);
    for (const s of steps.filter((x) => x.kind === 'visit')) {
      if (s.target.detail === true) expect(detailCapable).toContain(s.target.type);
      else if (s.target.detail === false) expect(idLessCapable).toContain(s.target.type);
    }
  });

  it('detects the documented dashboard route the first step relies on', () => {
    expect(detectResource({ pathname: '/documents', search: '?level=all' }).type).toBe('organization');
  });
});
