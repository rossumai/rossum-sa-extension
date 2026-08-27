// @vitest-environment jsdom
//
// The print page's new wait. Until assets existed no image ever reached that page — a relative
// reference had no bytes and an absolute one was a 401 — so `document.fonts.ready` plus two frames
// was the whole of "laid out". Multi-megabyte `data:` screenshots decode on the same renderer, and
// nothing awaited them, so `window.print()` could plausibly open over a document whose pictures had
// not painted.
//
// What is covered here is the wait itself. Its one CALLER is `boot()`, which runs on import against
// `chrome.storage.session` and `location.search` and has no test harness in this repo; that the
// dialog visibly opens after the pictures appear is on the human-verify list (design §5.6).
//
// Importing this module runs `boot()`. With no `?printId` it fails out on its first line, and the
// `#hint` element it would write to does not exist here either, so nothing happens.
import { describe, it, expect, vi } from 'vitest';
import { whenImagesSettle } from '../src/docs/printEntry.js';

const PNG = 'data:image/png;base64,AAAA';

function docWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('whenImagesSettle', () => {
  it('resolves at once for a document with nothing to decode', async () => {
    await expect(whenImagesSettle(docWith('<p>Just prose.</p>'))).resolves.toBeUndefined();
    // An `<img>` with no src reports `complete` in jsdom exactly as in a browser, so it is not
    // something to wait for — and neither is a page this never got a root for.
    await expect(whenImagesSettle(docWith('<img>'))).resolves.toBeUndefined();
    await expect(whenImagesSettle(null)).resolves.toBeUndefined();
  });

  it('waits for EVERY picture, counting a decode failure as settled', async () => {
    // FAKE timers, so the ceiling cannot resolve this by accident: with real ones a wait that had
    // stopped listening for `error` would still settle after 5 s, and this test would pass on the
    // fallback rather than on the events. Verified by mutation — with real timers it survived
    // deleting the `error` listener.
    vi.useFakeTimers();
    try {
      const root = docWith(`<img src="${PNG}"><img src="${PNG}">`);
      const imgs = [...root.querySelectorAll('img')];
      expect(imgs.map((img) => img.complete)).toEqual([false, false]);

      let settled = false;
      const wait = whenImagesSettle(root, 5000).then(() => {
        settled = true;
      });
      // Advancing by 0 flushes the microtask queue without letting the ceiling fire. `dispatchEvent`
      // itself is synchronous, so this is the only pumping the events need.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      imgs[0].dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // one still to go

      // `error`, not `load`: a `data:` URI the renderer cannot decode never fires `load`, and the
      // ceiling is for one that settles neither way — not for this, the ordinary failure.
      imgs[1].dispatchEvent(new Event('error'));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await wait;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up at the ceiling rather than holding the dialog shut forever', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const wait = whenImagesSettle(docWith(`<img src="${PNG}">`), 5000).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await wait;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the ceiling once the pictures are in, so nothing fires later', async () => {
    vi.useFakeTimers();
    try {
      const root = docWith(`<img src="${PNG}">`);
      let resolutions = 0;
      const wait = whenImagesSettle(root, 5000).then(() => {
        resolutions += 1;
      });
      root.querySelector('img')!.dispatchEvent(new Event('load'));
      await wait;
      // BEFORE advancing, or the assertion proves nothing: advancing past 5000 consumes an uncleared
      // ceiling and leaves the count at zero either way. Mutation-checked in that order.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10000);
      expect(resolutions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
