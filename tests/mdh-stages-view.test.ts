// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');
// The empty-stage explainer talks to the agent; keep it off the network.
vi.mock('../src/agent/agentApi.js', () => ({
  createChat: vi.fn(async () => 'chat-1'),
  streamMessage: vi.fn(async (chatId, content, { onEvent } = {}) => {
    if (content === '/persona cautious') return;
    onEvent?.({ type: 'text-delta', delta: 'country holds DEU, not DE.' });
    onEvent?.({ type: 'finish' });
  }),
}));
// Stub RecordCard: assert the readOnly prop without depending on its internals
// (covered by tests/mdh-record-card.test.js).
vi.mock('../src/mdh/components/RecordCard.jsx', () => ({
  default: (props: any) => h('div', { class: 'rc-stub', 'data-readonly': String(!!props.readOnly) }, JSON.stringify(props.record)),
}));

import * as api from '../src/mdh/api.js';
import * as agentApi from '../src/agent/agentApi.js';
import StagesView from '../src/mdh/components/StagesView.jsx';
import { hoveredStage, stagesShowDef, stagesSourceOpen, aiAvailable } from '../src/mdh/store.js';
import { _resetExplanationCache } from '../src/mdh/agent/explainEmpty.js';

async function waitFor(condition: any, description = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = condition(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let currentRoot: any = null;
function mount(props: any) {
  document.body.innerHTML = '';
  currentRoot = document.createElement('div');
  document.body.appendChild(currentRoot);
  render(h(StagesView, { onToggleStage: () => {}, inspectTarget: null, ...props }), currentRoot);
  return currentRoot;
}
function rerender(props: any) {
  render(h(StagesView, { onToggleStage: () => {}, inspectTarget: null, ...props }), currentRoot);
}

// A preview request ends in { $limit: 10 } — NOT the $collStats input-count probe
// ([{$collStats},{$limit:1}]) and NOT the per-stage { $count } probes.
const previewCalls = () =>
  vi.mocked(api.aggregate).mock.calls.filter((c) => {
    const pl = c[1];
    if (!Array.isArray(pl) || pl.length === 0) return false;
    if (pl[0]?.$collStats) return false;
    return pl[pl.length - 1]?.$limit != null;
  });

afterEach(() => {
  if (currentRoot) { render(null, currentRoot); currentRoot = null; }
  document.body.innerHTML = '';
  hoveredStage.value = null;
  stagesShowDef.value = false;
  stagesSourceOpen.value = false;
  aiAvailable.value = false;
  _resetExplanationCache();
});
beforeEach(() => {
  vi.clearAllMocks();
  hoveredStage.value = null;
  stagesShowDef.value = false;
  stagesSourceOpen.value = false; // the source card is collapsed by default
  aiAvailable.value = false;
  _resetExplanationCache();
});

describe('StagesView', () => {
  it('renders a source card plus one section per active stage', async () => {
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ _id: 'a' }] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.pipeline-inspect-section').length === 3, '3 sections');
    const text = root.textContent;
    expect(text).toContain('source');
    expect(text).toContain('vendors');   // named, not "input"
    expect(text).toContain('$match');
    expect(text).toContain('$limit');
    // It must NOT read as stage zero: no number badge on the source card.
    const source = root.querySelector('.pipeline-inspect-source');
    expect(source).toBeTruthy();
    expect(source.querySelector('.pipeline-inspect-num')).toBeNull();
    expect(source.textContent).not.toContain('input');
  });

  it('marks where the pipeline starts, and counts only the stages that run', async () => {
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: true, stage: { $sort: { a: -1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.pipeline-inspect-start'), 'divider rendered');
    expect(root.querySelector('.pipeline-inspect-start').textContent).toBe('pipeline starts here \u00b7 2 of 3 stages run');
  });

  it('omits the divider when there are no stages at all', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: [] });
    await waitFor(() => root.querySelector('.pipeline-inspect-source'), 'source card rendered');
    expect(root.querySelector('.pipeline-inspect-start')).toBeNull();
  });

  it('fires one 10-doc preview per active stage, $search first (none for the collapsed source)', async () => {
    const search = { $search: { index: 'default', text: { query: 'foo', path: 'name' } } };
    const entries = [{ disabled: false, stage: search }, { disabled: false, stage: { $match: { x: 1 } } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 2, '2 stage previews');
    const calls = previewCalls();
    // The bare [{ $limit }] source sample is NOT fetched while the card is collapsed.
    expect(calls.some((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 10 }]))).toBe(false);
    const stagePreviews = calls.filter((c) => c[1].length > 1);
    expect(stagePreviews.length).toBe(2);
    for (const [, pl] of stagePreviews) {
      expect(pl[0]).toEqual(search);
      expect(pl[pl.length - 1]).toEqual({ $limit: 10 });
    }
  });

  it('strips $out/$merge from every request', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $out: 'archive' } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 2, 'previews issued');
    for (const [, pl] of vi.mocked(api.aggregate).mock.calls) {
      for (const stage of pl) {
        const key = Object.keys(stage)[0];
        expect(key).not.toBe('$out');
        expect(key).not.toBe('$merge');
      }
    }
  });

  it('renders read-only RecordCards', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ _id: '1', name: 'ACME' }] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.rc-stub').length > 0, 'doc cards rendered');
    for (const stub of root.querySelectorAll('.rc-stub')) expect(stub.getAttribute('data-readonly')).toBe('true');
  });

  it('surfaces a per-stage preview error independently', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $sort: { _id: 1 } } }];
    vi.mocked(api.aggregate).mockImplementation((col, pl) => {
      if (JSON.stringify(pl) === JSON.stringify([{ $limit: 10 }])) return Promise.resolve({ result: [{ _id: 'i' }] });
      if (JSON.stringify(pl).includes('$sort')) return Promise.reject(Object.assign(new Error('boom'), { status: 400 }));
      return Promise.resolve({ result: [{ _id: '1' }] });
    });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.pipeline-inspect-error'), 'error rendered');
    const err = root.querySelector('.pipeline-inspect-error');
    expect(err.textContent).toContain('boom');
    expect(err.textContent).toMatch(/400/);
    expect(root.querySelectorAll('.rc-stub').length).toBeGreaterThan(0);
  });

  it('renders disabled stages greyed and issues no preview for them', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: true, stage: { $sort: { a: -1 } } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 1, '1 active preview');
    expect(root.querySelector('.pipeline-inspect-disabled')).not.toBeNull();
    for (const [, pl] of vi.mocked(api.aggregate).mock.calls) expect(JSON.stringify(pl)).not.toContain('$sort');
  });

  it('fetches and shows a count delta in the stage header', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    vi.mocked(api.aggregate).mockImplementation((col, pl) => {
      if (pl[0]?.$collStats) return Promise.resolve({ result: [{ count: 1240 }] });
      if (pl[pl.length - 1]?.$count) return Promise.resolve({ result: [{ n: 420 }] });
      return Promise.resolve({ result: [] });
    });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.textContent.includes('1,240') && root.textContent.includes('420'), 'counts rendered');
    expect(root.textContent).toContain('1,240');
    expect(root.textContent).toContain('420');
  });

  it('calls onToggleStage with the entry index when a stage toggle is clicked', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $limit: 50 } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const toggled: any = [];
    const root = mount({ collection: 'vendors', entries, onToggleStage: (i: any) => toggled.push(i) });
    await waitFor(() => root.querySelectorAll('.pipeline-stage-toggle').length === 2, 'two stage toggles');
    root.querySelectorAll('.pipeline-stage-toggle')[1].click();
    expect(toggled).toEqual([1]);
  });

  it('reflects a disabled stage when entries prop changes (live, no local copy)', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $sort: { _id: 1 } } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => vi.mocked(api.aggregate).mock.calls.some((c) => JSON.stringify(c[1]).includes('$sort')), '$sort referenced');
    vi.clearAllMocks();
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    rerender({ collection: 'vendors', entries: [{ disabled: false, stage: { $match: {} } }, { disabled: true, stage: { $sort: { _id: 1 } } }] });
    await waitFor(() => root.querySelector('.pipeline-inspect-disabled'), 'stage greyed via prop');
    await waitFor(() => vi.mocked(api.aggregate).mock.calls.length > 0, 'requests re-issued');
    expect(vi.mocked(api.aggregate).mock.calls.every((c) => !JSON.stringify(c[1]).includes('$sort'))).toBe(true);
  });

  it('no longer renders the per-stage query box (records are full-width)', async () => {
    const entries = [{ disabled: false, stage: { $match: { x: 1 } } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.pipeline-inspect-section'), 'section rendered');
    expect(root.querySelector('.pipeline-inspect-def')).toBeNull();
    expect(root.querySelector('.pipeline-inspect-output')).not.toBeNull();
  });

  it('renders each active stage\'s substituted definition when Definitions is on', async () => {
    stagesShowDef.value = true;
    const entries = [
      { disabled: false, stage: { $match: { code: 'AB-12', qty: 100 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.pipeline-inspect-stagedef').length === 2, 'two definition blocks');
    const defs = [...root.querySelectorAll('.pipeline-inspect-stagedef')].map((el) => el.textContent);
    // Faithful pretty-printed substituted stage object (values already resolved upstream).
    expect(defs[0]).toBe(JSON.stringify({ $match: { code: 'AB-12', qty: 100 } }, null, 2));
    expect(defs[0]).toContain('"code": "AB-12"');
    expect(defs[0]).toContain('"qty": 100');
    expect(defs[1]).toBe(JSON.stringify({ $limit: 50 }, null, 2));
  });

  it('renders no definition block when Definitions is off (default)', async () => {
    const entries = [{ disabled: false, stage: { $match: { x: 1 } } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.pipeline-inspect-section'), 'section rendered');
    expect(root.querySelector('.pipeline-inspect-stagedef')).toBeNull();
  });

  it('renders no definition block for the input section or disabled stages', async () => {
    stagesShowDef.value = true;
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: true, stage: { $sort: { a: -1 } } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.pipeline-inspect-stagedef').length === 1, 'exactly one def block');
    // Only the single active $match stage has a block: input (data-idx="-1") and the
    // disabled $sort do not.
    const inputSection = root.querySelector('.pipeline-inspect-section[data-idx="-1"]');
    expect(inputSection.querySelector('.pipeline-inspect-stagedef')).toBeNull();
    expect(root.querySelector('.pipeline-inspect-disabled .pipeline-inspect-stagedef')).toBeNull();
  });

  it('hovering a stage section publishes its entry index + element to hoveredStage', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $sort: { _id: 1 } } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('.pipeline-inspect-section[data-idx]').length >= 3, 'sections rendered');

    // The 2nd stage section is entry index 1 (input section has data-idx="-1").
    const sortSection = root.querySelector('.pipeline-inspect-section[data-idx="1"]');
    expect(sortSection).toBeTruthy();
    sortSection.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    expect(hoveredStage.value).toBeTruthy();
    expect(hoveredStage.value!.entryIndex).toBe(1);
    expect(hoveredStage.value!.el).toBe(sortSection);

    sortSection.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(hoveredStage.value).toBeNull();
  });

  it('scrolls to and highlights the inspectTarget stage', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const entries = [{ disabled: false, stage: { $match: {} } }, { disabled: false, stage: { $limit: 50 } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries, inspectTarget: { index: 1 } });
    await waitFor(() => root.querySelector('.pipeline-inspect-highlight'), 'highlighted section');
    expect(root.querySelector('.pipeline-inspect-highlight').getAttribute('data-idx')).toBe('1');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('fetches the source sample only once its card is expanded', async () => {
    const entries = [{ disabled: false, stage: { $match: {} } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ _id: 'a' }] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => previewCalls().length >= 1, 'stage preview issued');
    const bare = () => previewCalls().filter((c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 10 }]));
    expect(bare().length).toBe(0);        // collapsed: one fewer aggregate per open
    expect(root.querySelector('.pipeline-inspect-source .pipeline-inspect-body')).toBeNull();

    root.querySelector('.pipeline-inspect-source-head').click();
    await waitFor(() => bare().length === 1, 'source sample fetched on expand');
    await waitFor(() => root.querySelector('.pipeline-inspect-source .pipeline-inspect-body'), 'records shown');
  });

  it('reports the source card\'s expanded state for assistive tech', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: [{ disabled: false, stage: { $match: {} } }] });
    await waitFor(() => root.querySelector('.pipeline-inspect-source-head'), 'source head rendered');
    const head = root.querySelector('.pipeline-inspect-source-head');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.click();
    await waitFor(() => head.getAttribute('aria-expanded') === 'true', 'expanded reported');
  });

  it('stamps data-entry on active AND disabled sections so the caret can address either', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: true, stage: { $sort: { a: -1 } } },
      { disabled: false, stage: { $limit: 5 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelectorAll('[data-entry]').length === 3, 'all entries addressable');
    expect([...root.querySelectorAll('[data-entry]')].map((el) => el.getAttribute('data-entry')))
      .toEqual(['0', '1', '2']);
    expect(root.querySelector('[data-entry="1"]').classList.contains('pipeline-inspect-disabled')).toBe(true);
  });
});

describe('empty-stage explanation', () => {
  const EMPTY = [{ disabled: false, stage: { $match: { country: 'DE' } } }];

  it('keeps "No documents at this stage" AND renders the Fabry panel under it', async () => {
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.querySelector('.stage-explain'), 'Fabry panel rendered');
    expect(root.textContent).toContain('No documents at this stage');
    // The regression this guards: a throw during render left the stage body
    // stuck on "Loading…" and neither the message nor the panel ever appeared.
    expect(root.textContent).not.toContain('Loading');
  });

  it('streams the explanation into the panel', async () => {
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.textContent.includes('DEU'), 'explanation streamed in');
  });

  it('renders no panel when the agent is unavailable', async () => {
    aiAvailable.value = false;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.textContent.includes('No documents at this stage'), 'empty message');
    expect(root.querySelector('.stage-explain')).toBeNull();
  });

  it('explains only the FIRST empty stage, not every downstream one', async () => {
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $group: { _id: '$x' } } },
      { disabled: false, stage: { $sort: { n: -1 } } },
    ];
    const root = mount({ collection: 'vendors', entries });
    await waitFor(() => root.querySelector('.stage-explain'), 'one panel rendered');
    expect(root.querySelectorAll('.stage-explain').length).toBe(1);
    expect(root.querySelector('[data-idx="0"] .stage-explain')).toBeTruthy();
  });
});

describe('empty-stage explanation — placement and reuse', () => {
  const EMPTY = [{ disabled: false, stage: { $match: { country: 'DE' } } }];

  it('renders UNDER the message, not inside the horizontal record row', async () => {
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.querySelector('.stage-explain'), 'panel rendered');

    // .pipeline-inspect-output is `flex-direction: row` for record cards, so a
    // panel inside it sits BESIDE the message and is squeezed to a card's width.
    expect(root.querySelector('.pipeline-inspect-output .stage-explain')).toBeNull();
    // It is a section child, after the body — i.e. under the message, full width.
    const section = root.querySelector('[data-idx="0"]');
    const kids = [...section.children];
    expect(kids.indexOf(section.querySelector('.stage-explain')))
      .toBeGreaterThan(kids.indexOf(section.querySelector('.pipeline-inspect-body')));
  });

  it('lets an empty stage hug its content instead of holding a 324px records band', async () => {
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.querySelector('.stage-explain'), 'panel rendered');
    expect(root.querySelector('.pipeline-inspect-body-empty')).toBeTruthy();
  });

  it('keeps the fixed records band when the stage HAS documents', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ _id: 'a' }] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.querySelector('.rc-stub'), 'records rendered');
    expect(root.querySelector('.pipeline-inspect-body-empty')).toBeNull();
  });

  it('does not re-investigate when the source card is toggled', async () => {
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.textContent.includes('DEU'), 'explanation arrived');
    const asked = vi.mocked(agentApi.createChat).mock.calls.length;

    root.querySelector('.pipeline-inspect-source-head').click();   // expand
    await waitFor(() => root.querySelector('.pipeline-inspect-source .pipeline-inspect-body'), 'source expanded');
    root.querySelector('.pipeline-inspect-source-head').click();   // collapse
    await waitFor(() => !root.querySelector('.pipeline-inspect-source .pipeline-inspect-body'), 'source collapsed');

    // The toggle used to clear every stage preview, unmounting the panel and
    // starting a fresh investigation each time.
    expect(vi.mocked(agentApi.createChat).mock.calls.length).toBe(asked);
    expect(root.textContent).toContain('DEU'); // and the answer is still on screen
  });

  it('toggling the source card does not refetch the stage previews', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ _id: 'a' }] });
    const root = mount({ collection: 'vendors', entries: EMPTY });
    await waitFor(() => root.querySelector('.rc-stub'), 'records rendered');
    const before = previewCalls().length;
    root.querySelector('.pipeline-inspect-source-head').click();
    await waitFor(() => previewCalls().length > before, 'the source sample was fetched');
    // Exactly one new request — the source sample — not one per stage.
    expect(previewCalls().length).toBe(before + 1);
  });
});

describe('the empty-stage message is hard to miss', () => {
  it('renders as a warning band with an icon, not muted body text', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const root = mount({ collection: 'vendors', entries: [{ disabled: false, stage: { $match: {} } }] });
    await waitFor(() => root.querySelector('.pipeline-inspect-empty'), 'empty band rendered');
    const band = root.querySelector('.pipeline-inspect-empty');
    expect(band.textContent).toContain('No documents at this stage');
    expect(band.querySelector('.pipeline-inspect-empty-icon')).toBeTruthy();
    // Decorative: the sentence beside it already carries the meaning.
    expect(band.querySelector('.pipeline-inspect-empty-icon').getAttribute('aria-hidden')).toBe('true');
  });

  it('does not give the still-loading state the warning treatment', async () => {
    // A stage that has not resolved is not a warning — it is just not done.
    let resolve: any;
    vi.mocked(api.aggregate).mockReturnValue(new Promise((r) => { resolve = r; }));
    const root = mount({ collection: 'vendors', entries: [{ disabled: false, stage: { $match: {} } }] });
    await waitFor(() => root.querySelector('.pipeline-inspect-loading'), 'loading shown');
    expect(root.querySelector('.pipeline-inspect-empty')).toBeNull();
    resolve({ result: [] });
  });
});

describe('the written pipeline reaches the prompt', () => {
  it('passes rawStages and variables through to what the agent is asked', async () => {
    // Guards the prop chain, not just the prompt builder: the builder was fully
    // tested while the props were not actually being forwarded, so the agent saw
    // only the substituted form.
    aiAvailable.value = true;
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    mount({
      collection: 'vendors',
      entries: [{ disabled: false, stage: { $match: { country: '' } } }],
      rawStages: [{ $match: { country: '{country}' } }],
      variables: [{ name: 'country', value: '', isSet: false, type: 'auto' }],
    });
    await waitFor(() => vi.mocked(agentApi.streamMessage).mock.calls.length >= 2, 'prompt sent');
    // call 0 is the persona priming turn; call 1 carries the diagnostic prompt.
    const prompt = vi.mocked(agentApi.streamMessage).mock.calls[1][1];
    expect(prompt).toContain('AS WRITTEN');
    expect(prompt).toContain('{country}');
    expect(prompt).toContain('{country} = NOT SET');
  });
});
