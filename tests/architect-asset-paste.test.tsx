// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import SourceEditor, { referenceFor } from '../src/fabry/architect/components/SourceEditor.jsx';
import { SourceColumn } from '../src/fabry/architect/components/SpecView.jsx';
import { createAssetStore } from '../src/fabry/architect/assets.js';
import type { AssetRow } from '../src/fabry/architect/assets.js';

// Paste and drop into the deliverable being edited (design 2026-08-24 D3/§5.3). REAL CodeMirror and
// a REAL asset store over fake transports: nothing in this file can reach Data Storage or the
// Rossum API, and the built-in CodeMirror handling this path has to beat is the actual one.

type Deps = Parameters<typeof createAssetStore>[0];

function assetStore(over: Partial<Deps> = {}) {
  const server = new Map<string, any>();
  const calls = { post: [] as string[], hashed: 0 };
  let nextId = 900;
  const store = createAssetStore({
    find: async () => ({ result: [...server.values()] }),
    fetchBytes: async () => new Blob(['x']),
    sha256: async (buf: ArrayBuffer) => {
      calls.hashed += 1;
      return `sha-of-${new TextDecoder().decode(buf)}`;
    },
    postDocument: async (f: File) => {
      calls.post.push(f.name);
      return nextId++;
    },
    // The one property the write path rests on: `_id` is unique, so an insert against a taken key
    // fails rather than replacing what is there.
    insertRow: async (row: AssetRow) => {
      if (server.has(row.key)) throw new Error(`E11000 duplicate key: ${row.key}`);
      server.set(row.key, {
        _id: row.key,
        kind: 'asset',
        documentId: row.documentId,
        mime: row.mime,
        name: row.name,
        size: row.size,
        sha256: row.sha256,
        aliases: row.aliases,
      });
    },
    updateRow: async () => {},
    deleteDocument: async () => {},
    deleteRow: async () => {},
    ...over,
  });
  return { store, calls };
}

// An upload that never settles on its own, for the tests about what happens DURING one.
function pendingStore() {
  let release: (row: Partial<AssetRow>) => void = () => {};
  const store = {
    upload: (f: File) =>
      new Promise<{ row: AssetRow; reused: boolean }>((res) => {
        release = (row) =>
          res({
            row: {
              key: `assets/${f.name}`,
              documentId: 1,
              mime: 'image/png',
              name: f.name,
              size: 1,
              sha256: 's',
              aliases: [],
              uploadedAt: null,
              ...row,
            },
            reused: false,
          });
      }),
  };
  return { store, release: () => release({}) };
}

let mounted: any[] = [];
let notes: string[] = [];

function mount(props: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const viewRef: any = { current: null };
  act(() => {
    render(
      <SourceEditor viewRef={viewRef} onNote={(n: string) => notes.push(n)} {...props} />,
      root,
    );
  });
  mounted.push(root);
  return { root, view: viewRef.current, viewRef };
}

function rerender(root: any, props: any) {
  act(() => {
    render(<SourceEditor onNote={(n: string) => notes.push(n)} {...props} />, root);
  });
}

const png = (name: string, body: string) => new File([body], name, { type: 'image/png' });
const doc = (view: any) => view.state.doc.toString();

function pasteInto(target: any, init: { files?: File[]; text?: string }) {
  const ev: any = new Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = {
    files: init.files || [],
    getData: (t: string) => (t === 'text/plain' ? init.text || '' : ''),
  };
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function dropInto(target: any, files: File[], text = '') {
  const ev: any = new Event('drop', { bubbles: true, cancelable: true });
  // clientX/clientY so CodeMirror's own drop path can resolve a position when it is left to run.
  ev.clientX = 0;
  ev.clientY = 0;
  ev.dataTransfer = {
    types: files.length ? ['Files'] : ['text/plain'],
    files,
    getData: () => text,
    dropEffect: '',
  };
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

// One `await act()` flushes a microtask or two, not a whole batch: `ingest` awaits each upload in
// turn and the store queues each one behind an index read, so the path has to be driven until it
// reports itself done. Every outcome — added, reused, failed, or skipped because the editor closed
// — ends in a note, so the note count is that signal.
async function settle(count = 1, tries = 300) {
  for (let i = 0; i < tries && notes.length < count; i += 1) await act(async () => {});
  return notes;
}

// CodeMirror's built-in file drop reads the bytes with a FileReader, which delivers on a MACROTASK.
// A chain of awaited microtasks — which is all `settle` is — never lets one run, so a test cannot
// claim that handling did NOT also fire until it has handed the loop back.
const yieldToTimers = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 5));
  await act(async () => {});
};

beforeEach(() => {
  notes = [];
});

afterEach(() => {
  for (const root of mounted) act(() => render(null, root));
  mounted = [];
  document.body.innerHTML = '';
});

describe('referenceFor', () => {
  it('writes an image as an image', () => {
    expect(referenceFor('assets/diagram.png', 'diagram.png', 'image/png')).toBe(
      '![diagram.png](assets/diagram.png)',
    );
  });

  it('writes anything else as a link', () => {
    expect(referenceFor('assets/sample.csv', 'sample.csv', 'text/csv')).toBe(
      '[sample.csv](assets/sample.csv)',
    );
  });
});

describe('pasting a file into a deliverable', () => {
  // THE hazard: a browser hands over a generic name for every pasted screenshot, so without key
  // de-duplication the second paste's row would collide with the first and one of the two documents
  // would be orphaned with nothing referencing it.
  it('gives two identically-named screenshots two keys and two references', async () => {
    const { store, calls } = assetStore();
    const { view } = mount({ assets: store });

    pasteInto(view.contentDOM, { files: [png('image.png', 'one')] });
    await settle(1);
    pasteInto(view.contentDOM, { files: [png('image.png', 'two')] });
    await settle(2);

    expect(doc(view)).toBe('![image.png](assets/image.png)![image.png](assets/image-2.png)');
    // Two documents, not one overwritten by the other.
    expect(calls.post).toEqual(['image.png', 'image.png']);
  });

  it('links a file that is not an image, and says so through the note channel', async () => {
    const { store } = assetStore();
    const { view } = mount({ assets: store });
    pasteInto(view.contentDOM, {
      files: [new File(['a,b\n'], 'notes.csv', { type: 'text/csv' })],
    });
    await settle(1);
    expect(doc(view)).toBe('[notes.csv](assets/notes.csv)');
    expect(notes).toEqual(['Added assets/notes.csv']);
  });

  it('inserts at the cursor, not at the end of the document', async () => {
    const { store } = assetStore();
    const { view } = mount({ assets: store, text: 'before after' });
    view.dispatch({ selection: { anchor: 'before '.length } });
    pasteInto(view.contentDOM, { files: [png('image.png', 'one')] });
    await settle(1);
    expect(doc(view)).toBe('before ![image.png](assets/image.png)after');
  });

  // `SourceEditor`'s second effect replaces the WHOLE document when the stored text changes under it
  // — a restore, an accepted Refine, the 600 ms debounced round-trip — so an offset captured before
  // the await can be out of range, and CodeMirror throws on one.
  it('inserts where the cursor is when the upload lands, not where it was', async () => {
    const { store, release } = pendingStore();
    const { root, view } = mount({ assets: store, text: 'a'.repeat(40) });
    view.dispatch({ selection: { anchor: 40 } });
    pasteInto(view.contentDOM, { files: [png('image.png', 'one')] });
    // A restore lands while the file is still uploading: the document is now far shorter than the
    // offset the paste started from.
    rerender(root, { assets: store, text: 'b' });
    expect(doc(view)).toBe('b');
    await act(async () => {
      release();
    });
    await settle(1);
    expect(doc(view)).toBe('b![image.png](assets/image.png)');
  });

  // Deliverable text is user data: a reference to an asset that does not exist renders as the D8
  // error pill for every future reader, and nothing ever cleans it up.
  it('inserts nothing when the upload fails, and reports the file by name', async () => {
    const { store } = assetStore({
      postDocument: async () => {
        throw new Error('502 from the gateway');
      },
    });
    const { view } = mount({ assets: store, text: 'untouched' });
    pasteInto(view.contentDOM, { files: [png('image.png', 'one')] });
    await settle(1);
    expect(doc(view)).toBe('untouched');
    expect(notes).toEqual(['image.png could not be added: 502 from the gateway']);
  });

  // 7c: the ceiling lives in the store, so this path inherits it — and the refusal is named rather
  // than arriving as an opaque API error.
  it('reports the 40 MB ceiling instead of sending the file', async () => {
    const { store, calls } = assetStore();
    const big = png('huge.png', 'x');
    Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
    const { view } = mount({ assets: store });
    pasteInto(view.contentDOM, { files: [big] });
    await settle(1);
    expect(doc(view)).toBe('');
    expect(calls.post).toEqual([]);
    expect(notes).toEqual(['huge.png could not be added: over the 40 MB limit']);
  });

  // CodeMirror's own paste handling must keep working: it is how every ordinary edit arrives.
  it('leaves a plain text paste to CodeMirror', async () => {
    const { store, calls } = assetStore();
    const { view } = mount({ assets: store });
    const ev = pasteInto(view.contentDOM, { text: 'plain words' });
    await act(async () => {});
    expect(doc(view)).toBe('plain words');
    expect(ev.defaultPrevented).toBe(true); // CodeMirror claimed it, not us
    expect(calls.post).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('does nothing at all when no store was given', async () => {
    const { view } = mount({});
    pasteInto(view.contentDOM, { files: [png('image.png', 'one')] });
    await act(async () => {});
    expect(doc(view)).toBe('');
    expect(notes).toEqual([]);
  });
});

describe('dropping files into a deliverable', () => {
  // CodeMirror's built-in `drop` reads a dropped file as TEXT and inserts that. Claiming the event
  // is what stops the deliverable filling with the browser's own representation of the file.
  it('inserts the reference and not the browser text representation', async () => {
    const { store } = assetStore();
    const { view } = mount({ assets: store });
    const ev = dropInto(view.contentDOM, [png('image.png', 'one')], 'file:///tmp/image.png');
    await settle(1);
    await yieldToTimers();
    // Inert, kept only as a reading of the event: CodeMirror's `runHandlers` calls preventDefault
    // itself whenever a handler returns truthy, so this passes with our claim removed too. The
    // document below is what proves the built-in did not get the file.
    expect(ev.defaultPrevented).toBe(true);
    expect(doc(view)).toBe('![image.png](assets/image.png)');
  });

  it('puts each file of a batch on its own line, in the order dropped', async () => {
    const { store } = assetStore();
    const { view } = mount({ assets: store });
    dropInto(view.contentDOM, [png('first.png', 'a'), png('second.png', 'b')]);
    await settle(2);
    expect(doc(view)).toBe('![first.png](assets/first.png)\n![second.png](assets/second.png)');
    expect(notes[1]).toBe('Added assets/first.png, assets/second.png');
  });

  // The other three drag events, which is what makes the drop reachable at all: without a
  // preventDefault on dragover the browser stops firing `drop` on the editor and navigates to the
  // file instead. The highlight is the same one the Assets tab paints.
  it('claims the drag and highlights the editor while files are over it', () => {
    const { store } = assetStore();
    const { root, view } = mount({ assets: store });
    const host = root.querySelector('.fabry-spec-cm') as HTMLElement;
    const fire = (type: string) => {
      const ev: any = new Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = { types: ['Files'], files: [], dropEffect: '' };
      act(() => {
        view.contentDOM.dispatchEvent(ev);
      });
      return ev;
    };
    expect(fire('dragenter').defaultPrevented).toBe(true);
    expect(host.classList.contains('dragging')).toBe(true);
    const over = fire('dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    fire('dragleave');
    expect(host.classList.contains('dragging')).toBe(false);
  });

  // The note channel holds ONE message. A failure erased by the success that follows it is a
  // failure nobody ever hears about — the same lesson as the panel's log cap.
  it('keeps a failed file in the note when a later one in the batch succeeds', async () => {
    const { store } = assetStore({
      postDocument: async (f: File) => {
        if (f.name === 'bad.png') throw new Error('502 from the gateway');
        return 7;
      },
    });
    const { view } = mount({ assets: store });
    dropInto(view.contentDOM, [png('bad.png', 'a'), png('good.png', 'b')]);
    await settle(2);
    expect(doc(view)).toBe('![good.png](assets/good.png)');
    expect(notes[1]).toBe(
      'Added assets/good.png · bad.png could not be added: 502 from the gateway',
    );
  });

  // ACROSS batches, which is where the batch-local `added`/`failed` arrays stopped. Each paste
  // starts its own, the store's chain makes the first settle before the second, so the second's
  // success deterministically overwrote the first's failure — and this note is the ONLY record of
  // an editor upload: nothing on this path ever reaches the panel's log.
  it('keeps a failed paste in the note when a LATER paste succeeds', async () => {
    const { store } = assetStore({
      postDocument: async (f: File) => {
        if (f.name === 'bad.png') throw new Error('502 from the gateway');
        return 7;
      },
    });
    const { view } = mount({ assets: store });

    pasteInto(view.contentDOM, { files: [png('bad.png', 'a')] });
    await settle(1);
    expect(notes[0]).toBe('bad.png could not be added: 502 from the gateway');

    pasteInto(view.contentDOM, { files: [png('good.png', 'b')] });
    await settle(2);
    expect(doc(view)).toBe('![good.png](assets/good.png)');
    expect(notes[1]).toBe(
      'Added assets/good.png · bad.png could not be added: 502 from the gateway',
    );
  });

  // Carrying failures forward without a ceiling is the panel's 200-row bug in a place with even
  // less room: this is one line above the document. Past the cap the oldest become a count — a
  // count, not silence.
  it('names the most recent failures and counts the older ones', async () => {
    const { store } = assetStore({
      postDocument: async () => {
        throw new Error('502 from the gateway');
      },
    });
    const { view } = mount({ assets: store });
    for (let i = 0; i < 7; i += 1) {
      pasteInto(view.contentDOM, { files: [png(`f${i}.png`, String(i))] });
      await settle(i + 1);
    }
    expect(notes[5]).toMatch(/ · 1 earlier failure not shown$/);
    const last = notes[6];
    expect(last).not.toMatch(/f0\.png/);
    expect(last).not.toMatch(/f1\.png/);
    expect(last.startsWith('f2.png could not be added: 502 from the gateway · ')).toBe(true);
    expect(last).toMatch(
      /f6\.png could not be added: 502 from the gateway · 2 earlier failures not shown$/,
    );
    expect(doc(view)).toBe('');
  });

  // Dragging a selection inside the editor is CodeMirror's own gesture. Claiming a drag that
  // carries no files would take it away — the text would simply never arrive.
  it('leaves a drag carrying no files to CodeMirror', async () => {
    const { store, calls } = assetStore();
    const { view } = mount({ assets: store });
    dropInto(view.contentDOM, [], 'dragged text');
    await act(async () => {});
    expect(doc(view)).toBe('dragged text');
    expect(calls.post).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe('an editor destroyed while a file is uploading', () => {
  it('skips the insert rather than dispatching into a dead view', async () => {
    const { store, release } = pendingStore();
    const { root, view } = mount({ assets: store });
    const dispatch = vi.spyOn(view, 'dispatch');
    pasteInto(view.contentDOM, { files: [png('image.png', 'one')] });
    act(() => {
      render(null, root);
    });
    await act(async () => {
      release();
    });
    await settle(1);
    expect(dispatch).not.toHaveBeenCalled();
    // The file did reach the organization, so the user is still told about it.
    expect(notes).toEqual(['Added assets/image.png']);
  });
});

// The wrong-deliverable hazard, verified rather than assumed: SpecView keys each `<section>` by
// deliverable id, so Preact matches by key and never repurposes one deliverable's editor for
// another. Without the key it would reuse the FIRST section's DOM and EditorView for whatever
// section survived — and an upload started in the removed deliverable would land in it.
describe('one editor per deliverable', () => {
  const sections = [
    { id: 'd1', slug: 'one', text: '# One\n' },
    { id: 'd2', slug: 'two', text: '# Two\n' },
  ];
  const column = (root: any, list: any[], props: any = {}) =>
    act(() => {
      render(<SourceColumn sections={list} {...props} />, root);
    });
  const cmIn = (el: any) => el && el.querySelector('.cm-editor');

  it('keeps each deliverable its own EditorView when the list changes', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mounted.push(root);
    column(root, sections);
    const secs = [...root.querySelectorAll('[data-deliverable]')];
    const first = cmIn(secs[0]);
    const second = cmIn(secs[1]);
    expect(first).not.toBe(second);

    column(root, [sections[1]]);
    const left = root.querySelector('[data-deliverable="d2"]');
    expect(cmIn(left)).toBe(second);
    expect(root.contains(first)).toBe(false);
  });

  it('does not insert a removed deliverable’s upload into the one that remains', async () => {
    const { store, release } = pendingStore();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mounted.push(root);
    column(root, sections, { assets: store, onNote: (n: string) => notes.push(n) });

    const first = root.querySelector('[data-deliverable="d1"] .cm-content');
    pasteInto(first, { files: [png('image.png', 'one')] });
    column(root, [sections[1]]);
    await act(async () => {
      release();
    });
    await settle(1);

    const left = root.querySelector('[data-deliverable="d2"] .cm-content') as HTMLElement;
    expect(left.textContent).not.toMatch(/assets\//);
    expect(notes).toEqual(['Added assets/image.png']);
  });
});
