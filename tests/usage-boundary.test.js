import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { EVENT_NAMES } from '../src/usage/event.js';

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

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1);

describe('usage-data network boundary', () => {
  it('only src/usage/ga4Config.js names the analytics host', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((p) => rel(p) !== 'src/usage/ga4Config.js')
      .filter((p) => readFileSync(p, 'utf8').includes(HOST))
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
      .filter((p) => rel(p) !== 'dist/background.js')
      .filter((p) => readFileSync(p, 'utf8').includes(HOST))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('PRIVACY.md', () => {
  const text = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');

  it('publishes every event name so the claim is auditable', () => {
    expect(EVENT_NAMES.filter((n) => !text.includes(n))).toEqual([]);
  });

  it('carries the Chrome Web Store Limited Use affirmation', () => {
    expect(text).toMatch(/Limited Use/);
  });

  // PRIVACY.md is the ONE place the full list lives (the popup only links to
  // it), so it has to be complete in BOTH directions: a name the doc invented,
  // or kept after the code dropped it, is a false statement about what we send.
  it('lists no sa_* event that the code cannot actually send', () => {
    const inDoc = [...new Set([...text.matchAll(/`(sa_[a-z0-9_]+)`/g)].map((m) => m[1]))];
    expect(inDoc.filter((n) => !EVENT_NAMES.includes(n))).toEqual([]);
    expect(inDoc.length).toBe(EVENT_NAMES.length);
  });
});
