// @vitest-environment jsdom
//
// The Search Indexes card's test row: a value in, the engine's top hits out. Each
// hit is two lines (what matched, which record) and one click opens either the
// record or the engine's own score breakdown. Nothing here interprets the engine's
// explanation — that is the point of the "Why it scored" assertions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import SearchIndexCheck, { CHECK_DEBOUNCE_MS } from '../src/mdh/components/SearchIndexCheck.jsx';

function mount(node: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

// The row runs on its own after a pause in typing, so every test drives the
// clock rather than a button.
beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Lets the debounce fire and the answer land.
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
  });

function type(root: HTMLElement, value: string) {
  const input = root.querySelector<HTMLInputElement>('[data-testid="check-value"]')!;
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function runWith(rows: any[]) {
  const onCheck = vi.fn(async (_value: string) => rows);
  const root = mount(<SearchIndexCheck onCheck={onCheck} />);
  type(root, 'acme');
  await settle();
  return { root, onCheck };
}

// The shape api.aggregate returns for checkPipeline, trimmed.
const hit = {
  score: 6.214,
  highlights: [
    {
      score: 3,
      path: 'name',
      texts: [
        { value: 'Acme', type: 'hit' },
        { value: ' Metals', type: 'text' },
      ],
    },
    { score: 1, path: 'address.city', texts: [{ value: 'Springfield', type: 'hit' }] },
  ],
  scoreDetails: {
    value: 6.214,
    description: 'sum of:',
    details: [
      {
        value: 6.214,
        description: 'sum of:',
        details: [
          {
            value: 6.214,
            description: '$type:string/name:acme [BM25Similarity], result of:',
            details: [
              {
                value: 6.214,
                description: 'score(freq=1.0), computed as boost * idf * tf from:',
                details: [
                  { value: 0.8, description: 'boost', details: [] },
                  {
                    value: 3.2,
                    description: 'idf, computed as log(1 + (N - n + 0.5) / (n + 0.5)) from:',
                    details: [
                      {
                        value: 9,
                        description: 'n, number of documents containing term',
                        details: [],
                      },
                      {
                        value: 1200,
                        description: 'N, total number of documents with field',
                        details: [],
                      },
                    ],
                  },
                  {
                    value: 0.38,
                    description:
                      'tf, computed as freq / (freq + k1 * (1 - b + b * dl / avgdl)) from:',
                    details: [
                      {
                        value: 2,
                        description: 'freq, occurrences of term within document',
                        details: [],
                      },
                      { value: 5, description: 'dl, length of field', details: [] },
                      { value: 3.42, description: 'avgdl, average length of field', details: [] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  record: { _id: 'r1', name: 'Acme Metals', vendor_id: 'V-1', address: { city: 'Springfield' } },
};

const hitRow = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="check-hit"]')!;
const openHit = (root: HTMLElement) =>
  act(() => {
    hitRow(root).querySelector<HTMLElement>('[role="button"]')!.click();
  });

describe('SearchIndexCheck — the form', () => {
  it('has no button: the value is the whole control', () => {
    const root = mount(<SearchIndexCheck onCheck={vi.fn()} />);
    expect(root.querySelector('button')).toBeNull();
  });

  it('runs once, after the typing pauses, with the last value', async () => {
    const onCheck = vi.fn(async (_value: string) => [] as any[]);
    const root = mount(<SearchIndexCheck onCheck={onCheck} />);
    type(root, 'a');
    type(root, 'ac');
    type(root, 'acme');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS - 1);
    });
    expect(onCheck).not.toHaveBeenCalled();
    await settle();
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledWith('acme');
  });

  // An empty text query is not a search anyone meant to run.
  it('never runs a blank value, and clearing the value clears the results', async () => {
    const onCheck = vi.fn(async (_value: string) => [hit]);
    const root = mount(<SearchIndexCheck onCheck={onCheck} />);
    type(root, '   ');
    await settle();
    expect(onCheck).not.toHaveBeenCalled();

    type(root, 'acme');
    await settle();
    expect(root.querySelector('[data-testid="check-hit"]')).not.toBeNull();
    type(root, '');
    await settle();
    expect(root.querySelector('[data-testid="check-hit"]')).toBeNull();
    expect(root.querySelector('[data-testid="check-meta"]')).toBeNull();
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  // Typing on while a request is in flight must not let the older, slower answer
  // land on top of the newer one.
  it('drops a late answer to an earlier value', async () => {
    let releaseFirst: (rows: any[]) => void = () => {};
    const onCheck = vi.fn((value: string) =>
      value === 'old'
        ? new Promise<any[]>((resolve) => (releaseFirst = resolve))
        : Promise.resolve([] as any[]),
    );
    const root = mount(<SearchIndexCheck onCheck={onCheck} />);
    type(root, 'old');
    await settle();
    type(root, 'new');
    await settle();
    await act(async () => releaseFirst([hit]));
    expect(root.querySelector('[data-testid="check-hit"]')).toBeNull();
    expect(root.querySelector('[data-testid="check-meta"]')!.textContent).toContain('No match');
  });

  // A hit's open state belongs to that answer, not to its position in the list.
  it('collapses every hit when a new answer arrives', async () => {
    const onCheck = vi.fn(async (_value: string) => [hit]);
    const root = mount(<SearchIndexCheck onCheck={onCheck} />);
    type(root, 'acme');
    await settle();
    openHit(root);
    expect(root.querySelector('[data-testid="check-detail"]')).not.toBeNull();
    type(root, 'acmes');
    await settle();
    expect(root.querySelector('[data-testid="check-detail"]')).toBeNull();
  });

  it('carries the keyword/multi caveat on the results line, not on a row of its own', async () => {
    const { root } = await runWith([hit]);
    expect(root.querySelector('[data-testid="check-meta"]')!.textContent).toMatch(
      /1 best match .*keyword and multi fields are not searched/,
    );
  });

  it('says No match, with the caveat, when nothing comes back', async () => {
    const { root } = await runWith([]);
    const meta = root.querySelector('[data-testid="check-meta"]')!.textContent;
    expect(meta).toContain('No match');
    expect(meta).toContain('keyword and multi fields are not searched');
  });

  // A failed request is not a miss — see SearchIndexCheck for why.
  it('reports a failed check as could-not-run, never as No match', async () => {
    const root = mount(<SearchIndexCheck onCheck={vi.fn().mockRejectedValue(new Error('boom'))} />);
    type(root, 'acme');
    await settle();
    expect(root.textContent).toContain('could not run');
    expect(root.textContent).not.toContain('No match');
  });
});

describe('SearchIndexCheck — a collapsed hit', () => {
  it('shows each matched field as path then highlighted text, and the score', async () => {
    const { root } = await runWith([hit]);
    const row = hitRow(root);
    expect(row.textContent).toContain('name');
    expect(row.textContent).toContain('address.city');
    expect([...row.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
      'Acme',
      'Springfield',
    ]);
    expect(row.textContent).toContain('6.21');
  });

  // The record line identifies the record without repeating the match line.
  it('identifies the record, leaving out the top-level field already shown', async () => {
    const { root } = await runWith([hit]);
    const line = root.querySelector('[data-testid="check-record"]')!.textContent!;
    expect(line).toContain('vendor_id: "V-1"');
    expect(line).not.toContain('name:');
  });

  it('starts collapsed', async () => {
    const { root } = await runWith([hit]);
    expect(root.querySelector('[data-testid="check-detail"]')).toBeNull();
    expect(hitRow(root).querySelector('[role="button"]')!.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  // Highlight text is record data; it must reach the DOM as text, never markup.
  it('renders highlight text as text', async () => {
    const { root } = await runWith([
      { score: 1, highlights: [{ path: 'a', texts: [{ value: '<img src=x>', type: 'hit' }] }] },
    ]);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('mark')!.textContent).toBe('<img src=x>');
  });
});

describe('SearchIndexCheck — an opened hit', () => {
  // Why it scored is the point of a test, so it comes first and opens first.
  it('opens on Why it scored, listed before Record', async () => {
    const { root } = await runWith([hit]);
    openHit(root);
    const detail = root.querySelector('[data-testid="check-detail"]')!;
    const labels = [...detail.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent);
    expect(labels).toEqual(['Why it scored', 'Record']);
    expect(detail.querySelector('[data-testid="check-terms"]')).not.toBeNull();
    expect(detail.querySelector('.json-tree')).toBeNull();
    expect(hitRow(root).querySelector('[role="button"]')!.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('shows the record as a read-only JSON tree, with Copy', async () => {
    const { root } = await runWith([hit]);
    openHit(root);
    act(() =>
      [...root.querySelectorAll<HTMLButtonElement>('[data-testid="check-detail"] button')]
        .find((b) => b.textContent === 'Record')!
        .click(),
    );
    const detail = root.querySelector('[data-testid="check-detail"]')!;
    expect(detail.querySelector('.json-tree')!.textContent).toContain('V-1');
    expect(detail.textContent).toContain('Copy');
  });

  it('toggles open and shut from the keyboard', async () => {
    const { root } = await runWith([hit]);
    const btn = hitRow(root).querySelector<HTMLElement>('[role="button"]')!;
    act(() => {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(root.querySelector('[data-testid="check-detail"]')).not.toBeNull();
    act(() => {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(root.querySelector('[data-testid="check-detail"]')).toBeNull();
  });

  const openWhy = (root: HTMLElement) => {
    openHit(root);
    act(() =>
      [...root.querySelectorAll<HTMLButtonElement>('[data-testid="check-detail"] button')]
        .find((b) => b.textContent === 'Why it scored')!
        .click(),
    );
  };

  it('shows one row per matched term: field, term, points, and the total', async () => {
    const { root } = await runWith([hit]);
    openWhy(root);
    const rows = [...root.querySelectorAll('[data-testid="check-terms"] tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows[0]).toEqual(['name', 'acme', '9 of 1,200 records', '6.21', 'fuzzy']);
    expect(rows[rows.length - 1]).toContain('6.21');
    expect(root.querySelector('[data-testid="check-detail"] .json-tree')).toBeNull();
    expect(root.querySelector('[data-testid="check-detail"]')!.textContent).not.toContain('Copy');
  });

  // The evidence behind "fuzzy" is the engine's boost; it stays one hover away.
  it('puts the engine boost behind the fuzzy tag', async () => {
    const { root } = await runWith([hit]);
    openWhy(root);
    expect(
      root.querySelector('[data-testid="check-terms"] span[title]')!.getAttribute('title'),
    ).toContain('0.80');
  });

  // Field length and repeat count explain a score but rarely matter, so they sit
  // behind the points rather than in columns of their own.
  it('puts field length and repeat count behind the points', async () => {
    const { root } = await runWith([hit]);
    openWhy(root);
    const points = root.querySelector(
      '[data-testid="check-terms"] tbody tr td[title*="Field length"]',
    )!;
    expect(points.textContent).toBe('6.21');
    expect(points.getAttribute('title')).toBe(
      'Field length 5 terms (average 3.42). The term occurs 2 times in it.',
    );
  });

  // The raw tree is always available, folded under the table.
  it('keeps the raw breakdown one click below the table, word for word', async () => {
    const { root } = await runWith([hit]);
    openWhy(root);
    const raw = root.querySelector<HTMLDetailsElement>('[data-testid="check-raw"]')!;
    expect(raw.open).toBe(false);
    expect(raw.textContent).toContain('$type:string/name:acme [BM25Similarity], result of:');
  });

  // The one presentation rule: the top three levels open, the rest folded. It
  // counts depth only.
  it('opens the top three levels of the raw breakdown and folds the rest', async () => {
    const { root } = await runWith([hit]);
    openWhy(root);
    const open = [...root.querySelectorAll('[data-testid="check-explain"] details')].map(
      (d) => (d as HTMLDetailsElement).open,
    );
    // root, sum, term open; the formula and its idf/tf parts folded.
    expect(open).toEqual([true, true, true, false, false, false]);
  });

  // MongoDB does not guarantee the format; an unreadable breakdown shows raw.
  it('falls back to the raw breakdown, shown directly, when it cannot be read', async () => {
    const odd = {
      value: 1,
      description: 'max of:',
      details: [{ value: 1, description: 'new text', details: [] }],
    };
    const { root } = await runWith([{ ...hit, scoreDetails: odd }]);
    openWhy(root);
    expect(root.querySelector('[data-testid="check-terms"]')).toBeNull();
    expect(root.querySelector('[data-testid="check-raw"]')).toBeNull();
    expect(root.querySelector('[data-testid="check-explain"]')!.textContent).toContain('max of:');
  });

  // A missing piece disables its view rather than rendering an empty pane.
  it('disables Why it scored when the engine returned no breakdown', async () => {
    const { root } = await runWith([{ ...hit, scoreDetails: undefined }]);
    openHit(root);
    const why = [
      ...root.querySelectorAll<HTMLButtonElement>('[data-testid="check-detail"] button'),
    ].find((b) => b.textContent === 'Why it scored')!;
    expect(why.disabled).toBe(true);
    // …and the hit opens on the record instead of an empty pane.
    expect(root.querySelector('[data-testid="check-detail"] .json-tree')).not.toBeNull();
  });
});
