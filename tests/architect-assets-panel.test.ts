// @vitest-environment jsdom
//
// jsdom because the reference scan renders the markdown and reads the RESULT: `sanitizeHtml` and
// `collectAssetRefs` both go through `DOMParser`. That is the whole point of ruling 38 — the panel
// gates a delete, so its answer has to come from the same renderer the reader and the printer use.
import { describe, expect, it } from 'vitest';
import {
  capLog,
  groupAssets,
  logTail,
  reasonList,
  refsByAssetKey,
  refsInRendered,
  scanRefs,
} from '../src/fabry/architect/components/AssetsPanel.jsx';
import type { Log } from '../src/fabry/architect/components/AssetsPanel.jsx';

const row = (key: string) => ({
  key,
  documentId: 1,
  mime: 'image/png',
  name: key.split('/').pop() as string,
  size: 1,
  sha256: 's',
  aliases: [] as string[],
  uploadedAt: null,
});

describe('groupAssets', () => {
  const rows = [row('assets/a.png'), row('assets/b.png'), row('assets/c.png')];
  const refs = { 'assets/a.png': ['d1'], 'assets/b.png': ['d2', 'd3'] };

  it('leads with what the deliverable in view references', () => {
    const g = groupAssets(rows, refs, 'd1');
    expect(g.here.map((r) => r.key)).toEqual(['assets/a.png']);
    expect(g.elsewhere.map((r) => r.key)).toEqual(['assets/b.png']);
    expect(g.unused.map((r) => r.key)).toEqual(['assets/c.png']);
  });

  it('puts everything referenced under elsewhere when nothing points here', () => {
    const g = groupAssets(rows, refs, 'd9');
    expect(g.here).toEqual([]);
    expect(g.elsewhere).toHaveLength(2);
    expect(g.unused).toHaveLength(1);
  });

  it('treats an asset with an empty reference list as unused', () => {
    const g = groupAssets(rows, { 'assets/a.png': [] }, 'd1');
    expect(g.unused).toHaveLength(3);
  });

  it('groups everything under elsewhere or unused when nothing is in view', () => {
    const g = groupAssets(rows, refs, null);
    expect(g.here).toEqual([]);
    expect(g.elsewhere.map((r) => r.key)).toEqual(['assets/a.png', 'assets/b.png']);
    expect(g.unused.map((r) => r.key)).toEqual(['assets/c.png']);
  });
});

// RULING 38 — one ANSWER, not just one home. The panel's count gates a DELETE and the bytes exist
// in exactly one place (design §2), so a form that renders and prints may never read as zero
// references here. The old markdown regex (`!?[…](…)`) missed two of these four, and both of them
// resolve perfectly on screen and on paper.
describe('refsInRendered', () => {
  it('reads a raw <img> with a width — the only way to fix one, and deliberately allowed', () => {
    // `sanitize.ts` keeps `img` with `width`/`height`/`align` on purpose, and `assetSync` preserves
    // exactly those attributes when the asset resolves. Supported, not an abuse.
    expect(refsInRendered('<img src="assets/diagram.png" width="600" alt="arch">')).toEqual([
      'assets/diagram.png',
    ]);
  });

  it('reads a reference-style image, whose href is nowhere near the `!` that uses it', () => {
    expect(refsInRendered('![arch][a]\n\n[a]: assets/diagram.png\n')).toEqual([
      'assets/diagram.png',
    ]);
  });

  it('reads an inline image and an inline link, image first', () => {
    expect(refsInRendered('![shot](assets/a.png) and [f](assets/sample.csv)')).toEqual([
      'assets/a.png',
      'assets/sample.csv',
    ]);
  });

  it('still ignores a fenced example of the syntax, because the renderer makes it code', () => {
    expect(refsInRendered('```\n![not a link](assets/fenced.png)\n```')).toEqual([]);
    expect(refsInRendered('')).toEqual([]);
  });

  it('leaves the heading permalinks markdown-it-anchor adds out of the list', () => {
    // Otherwise a specification hands the panel a list that is mostly its own table of contents —
    // the same exclusion `collectAssetRefs` makes for the print path, because it IS that function.
    expect(refsInRendered('# Scope\n\n[up](#scope)\n')).toEqual([]);
  });
});

describe('scanRefs', () => {
  it('scans every deliverable', () => {
    const out = scanRefs([
      { id: 'd1', text: '![a](assets/a.png)' },
      { id: 'd2', text: '[b](assets/b.png)' },
    ]);
    expect(out.scanned).toEqual([
      { id: 'd1', hrefs: ['assets/a.png'] },
      { id: 'd2', hrefs: ['assets/b.png'] },
    ]);
    expect(out.unscanned).toBe(0);
  });

  // A deliverable whose references are UNKNOWN must not be counted as one that references nothing:
  // that is the false report the whole scan exists to remove, and the panel says so beside the
  // delete confirmation rather than asserting past it.
  it('counts a deliverable it could not render instead of reading it as empty', () => {
    const out = scanRefs(
      [
        { id: 'd1', text: 'fine' },
        { id: 'd2', text: 'boom' },
      ],
      (text) => {
        if (text === 'boom') throw new Error('renderer gave up');
        return ['assets/a.png'];
      },
    );
    expect(out.scanned).toEqual([{ id: 'd1', hrefs: ['assets/a.png'] }]);
    expect(out.unscanned).toBe(1);
  });
});

// The reference an author writes is resolved to the row it points AT, which is the only
// thing that makes an alias (a reference written before this feature existed) count as a
// reference to the file it resolves to rather than as an orphan.
describe('refsByAssetKey', () => {
  const lookup = (href: string) =>
    href === 'assets/a.png' || href === 'https://example.test/old/a.png'
      ? { key: 'assets/a.png' }
      : null;

  it('lists the deliverables that reference each row, by row key', () => {
    const out = refsByAssetKey(
      scanRefs([
        { id: 'd1', text: '![a](assets/a.png)' },
        { id: 'd2', text: 'see ![a](https://example.test/old/a.png)' },
      ]).scanned,
      lookup,
    );
    expect(out).toEqual({ 'assets/a.png': ['d1', 'd2'] });
  });

  it('counts a deliverable once however many times it references the same file', () => {
    const out = refsByAssetKey(
      scanRefs([{ id: 'd1', text: '![a](assets/a.png)\n\n[again](assets/a.png)' }]).scanned,
      lookup,
    );
    expect(out['assets/a.png']).toEqual(['d1']);
  });

  it('ignores a reference that resolves to no row', () => {
    expect(refsByAssetKey(scanRefs([{ id: 'd1', text: '[x](other.md)' }]).scanned, lookup)).toEqual(
      {},
    );
  });
});

// W8: the reasons, not just a count. Three 401s used to report "3 of 3 could not be downloaded" and
// nothing else, in the one action D6 makes mandatory.
describe('reasonList', () => {
  it('says nothing when nothing failed', () => {
    expect(reasonList([])).toBe('');
  });

  it('names the reasons it has room for and counts the rest', () => {
    expect(reasonList(['a', 'b'])).toBe('a · b');
    expect(reasonList(['a', 'b', 'c', 'd'])).toBe('a · b · c · 1 other reason');
    expect(reasonList(['a', 'b', 'c', 'd', 'e'])).toBe('a · b · c · 2 other reasons');
  });
});

// R2. The panel is the only place an upload failure is ever reported, so the cap must never be the
// reason one is missing: in a 15-file batch whose first file fails, "3 earlier, not shown" was the
// entire report of that failure.
describe('capLog', () => {
  const log = (states: string[]): Log => ({
    rows: states.map((state, id) => ({ id, name: `f${id}.png`, state }) as any),
    earlier: 0,
    earlierFailed: 0,
  });
  const many = (state: string, n: number) => Array.from({ length: n }, () => state);
  const kept = (l: Log, state: string) => l.rows.filter((r) => r.state === state).length;

  it('collapses successes past the cap into a count', () => {
    const out = capLog(log(many('added', 15)));
    expect(out.rows).toHaveLength(12);
    expect(out.earlier).toBe(3);
    expect(out.earlierFailed).toBe(0);
    expect(out.rows[11].name).toBe('f14.png');
  });

  it('keeps a failure the cap would have dropped, and drops a success instead', () => {
    const out = capLog(log(['failed', ...many('added', 20)]));
    expect(out.rows[0].state).toBe('failed');
    expect(kept(out, 'added')).toBe(11);
    expect(out.earlier).toBe(9);
    expect(out.earlierFailed).toBe(0);
  });

  it('keeps far more failures than the cap, at the cost of every success', () => {
    const out = capLog(log([...many('failed', 30), ...many('added', 5)]));
    expect(kept(out, 'failed')).toBe(30);
    expect(kept(out, 'added')).toBe(0);
    expect(out.earlier).toBe(5);
  });

  // A row still uploading has no outcome yet, so dropping it would drop the failure it may become
  // — reachable whenever a drop starts a second batch during a folder import.
  it('never drops a row that is still uploading', () => {
    const out = capLog(log([...many('uploading', 3), ...many('added', 20)]));
    expect(kept(out, 'uploading')).toBe(3);
    expect(out.rows).toHaveLength(15);
  });

  it('counts failures separately once even they are past a sane bound', () => {
    const out = capLog(log(many('failed', 52)));
    expect(kept(out, 'failed')).toBe(50);
    expect(out.earlierFailed).toBe(2);
    expect(out.earlier).toBe(0);
    expect(out.rows[0].name).toBe('f2.png');
  });
});

describe('logTail', () => {
  const tail = (earlier: number, earlierFailed: number) =>
    logTail({ rows: [], earlier, earlierFailed });

  it('says nothing when nothing was collapsed', () => {
    expect(tail(0, 0)).toBe('');
  });

  it('counts collapsed successes as earlier', () => {
    expect(tail(3, 0)).toBe('3 earlier, not shown');
  });

  // "N earlier" reads as "nothing went wrong". A failure that was collapsed has to still say so.
  it('names collapsed failures as failures', () => {
    expect(tail(0, 2)).toBe('2 failed, not shown');
    expect(tail(3, 2)).toBe('2 failed · 3 earlier, not shown');
  });
});
