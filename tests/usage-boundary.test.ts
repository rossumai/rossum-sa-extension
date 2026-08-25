import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { EVENT_NAMES, buildPayload } from '../src/usage/event.js';

// Network boundary: exactly ONE module may name the analytics host, and only the
// service worker may send. If the host appears anywhere else, some other surface
// grew its own sender — bypassing the consent gate and the payload allowlist.
// Same shape as tests/fabry-write-boundary.test.js.
//
// The host lives in ga4Config.js (with the credentials), NOT in event.js, so the
// vocabulary stays importable from any surface — a popup or content-script import
// of event.js must never pull the analytics host into that bundle.
const ROOT = process.cwd();
const HOST = 'google-analytics.com';

function walk(dir: any): any {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: any) => p.slice(ROOT.length + 1);

describe('usage-data network boundary', () => {
  it('only src/usage/ga4Config names the analytics host', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((p: any) => !/^src\/usage\/ga4Config\.(js|ts)$/.test(rel(p)))
      .filter((p: any) => readFileSync(p, 'utf8').includes(HOST))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the background bundle really does ship the host', () => {
    // Without this, the absence check below passes against a stale or
    // feature-less dist/ — proving nothing about what actually ships.
    const bg = join(ROOT, 'dist', 'background.js');
    if (!existsSync(bg)) {
      throw new Error('run `npm run build` before this test — it inspects dist/');
    }
    expect(readFileSync(bg, 'utf8')).toContain(HOST);
  });

  it('only the background bundle ships the host', () => {
    const dist = join(ROOT, 'dist');
    if (!existsSync(dist)) {
      throw new Error('run `npm run build` before this test — it inspects dist/');
    }
    const offenders = walk(dist)
      .filter((p: any) => rel(p) !== 'dist/background.js')
      .filter((p: any) => readFileSync(p, 'utf8').includes(HOST))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('PRIVACY.md', () => {
  const text = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');

  it('publishes every event name in backticks, so the list is a real list', () => {
    // The looser `text.includes(name)` would accept a name buried in prose, or
    // matched only as a substring of a longer name. The document IS the
    // published vocabulary, so every name must appear as code.
    expect(EVENT_NAMES.filter((n) => !text.includes(`\`${n}\``))).toEqual([]);
  });

  it('carries the Chrome Web Store Limited Use affirmation', () => {
    expect(text).toMatch(/Limited Use/);
  });

  // PRIVACY.md is the ONE place the full list lives (the popup only links to
  // it), so it has to be complete in BOTH directions: a name the doc invented,
  // or kept after the code dropped it, is a false statement about what we send.
  it('lists no sa_* event that the code cannot actually send', () => {
    const inDoc = [...new Set([...text.matchAll(/`(sa_[a-z0-9_]+)`/g)].map((m) => m[1]))];
    expect(inDoc.filter((n) => !(EVENT_NAMES as readonly string[]).includes(n))).toEqual([]);
    expect(inDoc.length).toBe(EVENT_NAMES.length);
  });

  // PRIVACY.md promises each event contains EXACTLY: the event name, the
  // extension version, a random client identifier and a random per-session
  // identifier. That is a promise about the PAYLOAD, and after 2026-08-19
  // nothing else pins it — the parameter allowlist that used to make it
  // self-evident was deleted, because no caller can supply a param any more.
  // If this fails, the payload gained or lost a field and the "containing
  // exactly" list in PRIVACY.md is now FALSE. Fix the document, not the
  // assertion.
  it('sends exactly the fields PRIVACY.md promises, for every event', () => {
    for (const name of EVENT_NAMES) {
      const body = buildPayload({
        name, clientId: 'c1', sessionId: 's1', version: 'abc1234',
      });
      expect(Object.keys(body).sort()).toEqual(['client_id', 'events']);
      expect(body.events).toHaveLength(1);
      expect(Object.keys(body.events[0]).sort()).toEqual(['name', 'params']);
      expect(Object.keys(body.events[0].params).sort())
        .toEqual(['engagement_time_msec', 'ext_ver', 'session_id']);
    }
  });
});
