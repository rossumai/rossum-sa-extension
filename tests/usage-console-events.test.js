import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { EVENT_NAMES } from '../src/usage/event.js';

const ROOT = process.cwd();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Every `sa_*` event-name literal anywhere in src/ must be a name the
// vocabulary knows, or the worker silently drops the event — and a dropped
// event looks exactly like "nobody uses this feature". Scanning for the literal
// (rather than for `track('…')` call sites) also catches names dispatched
// through a lookup map, which is how the Console emits its per-app events.
// event.js is excluded because it IS the vocabulary.
// Extension-agnostic: this module moved to .ts on 2026-08-20, and naming it by extension
// silently turned the skip below into a no-op.
const VOCAB_RE = /src[/\\]usage[/\\]event\.(js|ts)$/;

describe('instrumented event names', () => {
  const used = new Set();
  for (const file of walk(join(ROOT, 'src'))) {
    if (VOCAB_RE.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/'(sa_[a-z0-9_]+)'/g)) used.add(m[1]);
  }

  it('actually skips the vocabulary file — otherwise these tests are tautologies', () => {
    expect(walk(join(ROOT, 'src')).filter((f) => VOCAB_RE.test(f))).toHaveLength(1);
  });

  it('found call sites', () => {
    expect(used.size).toBeGreaterThan(20);
  });

  it('uses only names from the vocabulary', () => {
    expect([...used].filter((n) => !EVENT_NAMES.includes(n))).toEqual([]);
  });

  it('covers every Console app and the DevTools panel', () => {
    for (const n of [
      'sa_console_open', 'sa_console_app_mdh', 'sa_console_app_audit',
      'sa_console_app_inspector', 'sa_console_app_galaxy', 'sa_console_app_fabry',
      'sa_devtools_panel_open',
    ]) expect(used.has(n)).toBe(true);
  });
});
