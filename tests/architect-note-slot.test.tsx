// @vitest-environment jsdom
//
// The document bar's note is ONE slot with FOUR writers (ruling 39), and two different things ride
// in it: an upload failure the reader has not dismissed, and the `busy` sentinel the PDF button keys
// its disabled state and its label off. A writer that replaces the line wholesale takes the first
// away; a writer that replaces it at all takes the second away and lets a second print start on top
// of the first. Both were reachable through `onAssetOpen`, which used a raw `setNote`.
//
// DocView is mocked here — and nowhere else in the suite — because its `onAssetOpen` prop is the
// only way into that writer, and reaching it through a real rendered link would need the live
// singleton store to have an index.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/fabry/architect/pdfAction.js', () => ({ openPdfFlow: vi.fn() }));

const docProps = vi.hoisted(() => [] as any[]);
vi.mock('../src/docs/components/DocView.jsx', () => ({
  default: (props: any) => {
    docProps.push(props);
    return <div class="docview-mock" />;
  },
}));

const editorProps = vi.hoisted(() => [] as any[]);
vi.mock('../src/fabry/architect/components/SourceEditor.jsx', () => ({
  default: ({ text, ...rest }: any) => {
    editorProps.push(rest);
    return <textarea class="cm-mock" value={text} />;
  },
}));

const download = vi.hoisted(() => vi.fn());
// Partial: `store.ts` builds the one live asset store from this module at import time, so the rest
// of it has to stay real.
vi.mock('../src/fabry/architect/assetApi.js', async (orig) => ({
  ...(await orig<typeof import('../src/fabry/architect/assetApi.js')>()),
  downloadAsset: download,
}));

import { openPdfFlow } from '../src/fabry/architect/pdfAction.js';
import { keepBusy, noteWith } from '../src/fabry/architect/noteText.js';
import * as store from '../src/fabry/architect/store.js';
import SpecView from '../src/fabry/architect/components/SpecView.jsx';
import { deliverable } from './support/architect.js';

const HELD = { lines: ['shot.png could not be added: 502 Bad Gateway'], hidden: 0 };

let mounted: any[] = [];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<SpecView />, root);
  });
  mounted.push(root);
  return root;
}
afterEach(() => {
  for (const root of mounted)
    act(() => {
      render(null, root);
    });
  mounted = [];
});
beforeEach(() => {
  vi.clearAllMocks();
  docProps.length = 0;
  editorProps.length = 0;
  document.body.innerHTML = '';
  store.deliverables.value = [
    deliverable({ id: 'd1', text: '# One\n\nalpha\n', order: 1, title: '', titleSource: '' }),
  ];
  store.results.value = {};
  store.docView.value = 'preview';
  store.pinnedTarget.value = null;
  store.spyTarget.value = null;
  store.setReviewTarget(null);
});

const noteText = (root: any) =>
  (root.querySelector('.fabry-arch-doc-note') as HTMLElement | null)?.textContent || '';
const pdfBtn = (root: any) => root.querySelector('[data-act="pdf"]') as HTMLButtonElement;

// The sentinel's owner may replace it; nobody else may. That asymmetry is the whole rule, and it is
// a function rather than four careful call sites.
describe('keepBusy', () => {
  it('defers to the sentinel', () => {
    expect(keepBusy('busy', 'print view opened')).toBe('busy');
    expect(keepBusy('busy', null)).toBe('busy');
  });

  it('writes anything else through', () => {
    expect(keepBusy(null, 'Copied assets/a.png')).toBe('Copied assets/a.png');
    expect(keepBusy('an earlier note', null)).toBe(null);
    expect(keepBusy(null, 'busy')).toBe('busy');
  });
});

describe('an asset link opened from the document column', () => {
  async function openAsset(root: any, href = 'assets/report.xlsx') {
    await act(async () => {
      docProps[docProps.length - 1].onAssetOpen(href);
    });
  }

  it('a successful download clears its own line and keeps the held upload failure', async () => {
    download.mockResolvedValue(null);
    const root = mount();
    // Seed a failure the way an editor paste does: the carrier is SpecView's, shared by every
    // editor and by the PDF flow, and dismissal is the only thing that empties it. A mode switch
    // does not remount SpecView, which is exactly why the failure is still held in Preview.
    store.docView.value = 'edit';
    act(() => {
      render(<SpecView />, root);
    });
    editorProps[editorProps.length - 1].failures.current = HELD;
    store.docView.value = 'preview';
    act(() => {
      render(<SpecView />, root);
    });

    await openAsset(root);
    expect(noteText(root)).toMatch(/502 Bad Gateway/);
  });

  it('a successful download clears the strip when nothing is held', async () => {
    download.mockResolvedValue(null);
    const root = mount();
    await openAsset(root);
    expect(root.querySelector('.fabry-arch-doc-note')).toBe(null);
  });

  it('a failed download is reported beside the failure already held', async () => {
    download.mockResolvedValue('report.xlsx: 404 Not Found');
    const root = mount();
    store.docView.value = 'edit';
    act(() => {
      render(<SpecView />, root);
    });
    editorProps[editorProps.length - 1].failures.current = HELD;
    store.docView.value = 'preview';
    act(() => {
      render(<SpecView />, root);
    });

    await openAsset(root);
    const note = noteText(root);
    expect(note).toMatch(/404 Not Found/);
    expect(note).toMatch(/502 Bad Gateway/);
  });

  it('a rejected download still says something', async () => {
    download.mockRejectedValue(new Error('boom'));
    const root = mount();
    await openAsset(root);
    expect(noteText(root)).toMatch(/assets\/report\.xlsx could not be downloaded/);
  });

  // `runPdf` takes seconds. A click on any asset link during it used to re-enable the button and
  // flip its label back, which allows a second print to start on top of the first (design §5.6).
  it('leaves the busy sentinel alone while a print is being prepared', async () => {
    download.mockResolvedValue(null);
    const root = mount();
    act(() => {
      pdfBtn(root).click();
    });
    const { onNote } = vi.mocked(openPdfFlow).mock.calls[0][1] as any;
    act(() => {
      onNote('busy');
    });
    expect(pdfBtn(root).disabled).toBe(true);
    expect(pdfBtn(root).textContent).toMatch(/Preparing/);

    await openAsset(root);

    expect(pdfBtn(root).disabled).toBe(true);
    expect(pdfBtn(root).textContent).toMatch(/Preparing/);
    // and the flow's own next message still lands, because the flow owns the sentinel
    act(() => {
      onNote('print view opened');
    });
    expect(noteText(root)).toMatch(/print view opened/);
  });
});

// The editors are the FOURTH writer, and they compose their own line — so they need the guard and
// not the composition. Same defect shape, reachable in Edit mode where the PDF button also lives.
describe('an editor upload report', () => {
  it('leaves the busy sentinel alone', () => {
    store.docView.value = 'edit';
    const root = mount();
    act(() => {
      pdfBtn(root).click();
    });
    const { onNote } = vi.mocked(openPdfFlow).mock.calls[0][1] as any;
    act(() => {
      onNote('busy');
    });
    act(() => {
      editorProps[editorProps.length - 1].onNote(noteWith('Added assets/shot.png', HELD));
    });
    expect(pdfBtn(root).disabled).toBe(true);
    expect(pdfBtn(root).textContent).toMatch(/Preparing/);
  });

  it('is shown as the editor composed it when no print is running', () => {
    store.docView.value = 'edit';
    const root = mount();
    act(() => {
      editorProps[editorProps.length - 1].onNote(noteWith('Added assets/shot.png', HELD));
    });
    const note = noteText(root);
    expect(note).toMatch(/Added assets\/shot\.png/);
    expect(note).toMatch(/502 Bad Gateway/);
  });
});
