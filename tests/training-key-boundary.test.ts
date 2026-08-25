import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { RECEIPT_KEY } from '../src/training/receiptKey.js';

// The receipt signing key must live in exactly one module, and must only ever
// reach the Console bundle — the Academy mints and validates, and no other
// surface needs it. Same shape as tests/usage-boundary.test.js.
const ROOT = process.cwd();

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

describe('receipt key boundary', () => {
  it('is not the placeholder', () => {
    expect(RECEIPT_KEY).not.toMatch(/REPLACE_WITH/);
    expect(RECEIPT_KEY.length).toBeGreaterThan(20);
  });

  it('only src/training/receiptKey names it', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((p: any) => !/^src\/training\/receiptKey\.(js|ts)$/.test(rel(p)))
      .filter((p: any) => readFileSync(p, 'utf8').includes(RECEIPT_KEY))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the console bundle really does ship it', () => {
    const f = join(ROOT, 'dist', 'console', 'console.js');
    if (!existsSync(f)) throw new Error('run `npm run build` before this test — it inspects dist/');
    expect(readFileSync(f, 'utf8')).toContain(RECEIPT_KEY);
  });

  it('no other bundle ships it — the content script must never carry the key', () => {
    const dist = join(ROOT, 'dist');
    if (!existsSync(dist)) throw new Error('run `npm run build` before this test — it inspects dist/');
    const offenders = walk(dist)
      .filter((p: any) => rel(p) !== 'dist/console/console.js')
      .filter((p: any) => readFileSync(p, 'utf8').includes(RECEIPT_KEY))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
