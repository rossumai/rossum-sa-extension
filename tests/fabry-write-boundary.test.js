import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Write-boundary guard (owner invariant: "Chat is strictly read-only; only
// Architect may write"). The Agent API has NO server-side write-lock — a chat
// turn is read-only ONLY because our client omits `mcp_mode` on the message.
// Write-enablement (`mcp_mode: "read-write"`) is therefore allowed to appear in
// EXACTLY two places:
//   - src/agent/agentApi.js       — the transport that DEFINES the mcpMode option
//   - src/fabry/architect/**      — the Architect implement loop (the only enabler)
// If the token "read-write" shows up in any other surface (Chat, Inspector,
// Audit, MDH, deep-verify, …) this test fails — that surface would no longer be
// read-only. See docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md.
const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1);

function isAllowed(r) {
  // Extension-agnostic: the transport moved to .ts on 2026-08-20 and this guard went
  // vacuous until the walker above learned about it.
  return /^src\/agent\/agentApi\.(js|ts)$/.test(r) || r.startsWith('src/fabry/architect/');
}

describe('agent write-enablement is Architect-only (Chat is strictly read-only)', () => {
  it('no source file outside the transport definition + Architect references "read-write" mode', () => {
    const offenders = walk(SRC)
      .filter((p) => {
        const r = rel(p);
        if (isAllowed(r)) return false;
        return readFileSync(p, 'utf8').includes('read-write');
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
