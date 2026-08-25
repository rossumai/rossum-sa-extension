// @vitest-environment jsdom
// The PDF dialog: scope is asked every time, the content options are remembered
// (owner, 2026-08-18: "ask at click time" + "consider making this configurable").
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { modalContent, closeModal } from '../src/ui/Modal.jsx';
import * as store from '../src/fabry/architect/store.js';
import { openPdfDialog } from '../src/fabry/architect/components/PdfDialog.jsx';

function openAndMount({ deliverableTitle = 'Scope', count = 3 } = {}) {
  const confirmed: any = [];
  openPdfDialog({ deliverableTitle, count }, (arg: any) => confirmed.push(arg));
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(modalContent.value!.render(), root);
  });
  return { root, confirmed };
}
const rows = (root: any) => [...root.querySelectorAll('.fabry-arch-pdf-row')];
const input = (root: any, label: any) =>
  rows(root)
    .find((r) => r.textContent.includes(label))
    .querySelector('input');

beforeEach(() => {
  closeModal();
  document.body.replaceChildren();
  store.pdfOptions.value = { contents: true, verdicts: false };
  vi.clearAllMocks();
});

describe('scope', () => {
  it('defaults to the whole specification when there is more than one deliverable', () => {
    const { root } = openAndMount({ count: 3 });
    expect(input(root, 'Whole specification').checked).toBe(true);
    expect(input(root, 'This deliverable').checked).toBe(false);
    expect(root.textContent).toMatch(/3 deliverables/);
  });

  it('falls back to this deliverable, and disables the other option, when only one exists', () => {
    const { root } = openAndMount({ count: 1 });
    expect(input(root, 'This deliverable').checked).toBe(true);
    expect(input(root, 'Whole specification').disabled).toBe(true);
    expect(root.textContent).toMatch(/only one deliverable exists/);
  });

  it('names the deliverable it would print', () => {
    const { root } = openAndMount({ deliverableTitle: 'Integration design' });
    expect(root.textContent).toMatch(/Integration design/);
  });

  it('reports the scope on confirm', () => {
    const { root, confirmed } = openAndMount({ count: 2 });
    act(() => {
      input(root, 'This deliverable').click();
    });
    act(() => {
      [...root.querySelectorAll('button')]
        .find((b) => /print dialog/i.test(b.textContent))!
        .click();
    });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].scope).toBe('one');
  });
});

describe('content options', () => {
  it('starts from the remembered values', () => {
    store.pdfOptions.value = { contents: false, verdicts: true };
    const { root } = openAndMount();
    expect(input(root, 'Contents page').checked).toBe(false);
    expect(input(root, 'Check verdict').checked).toBe(true);
    // The manual state was dropped on 2026-08-19, so there is no third option to offer.
    expect(root.textContent).not.toMatch(/State badge/);
  });

  it('persists them on confirm, so they are never re-asked', () => {
    const { root, confirmed } = openAndMount();
    act(() => {
      input(root, 'Check verdict').click();
    });
    act(() => {
      [...root.querySelectorAll('button')]
        .find((b) => /print dialog/i.test(b.textContent))!
        .click();
    });
    expect(store.pdfOptions.value).toEqual({ contents: true, verdicts: true });
    expect(confirmed[0].options).toEqual({ contents: true, verdicts: true });
  });

  it('disables the contents page when it would have nothing to list', () => {
    const { root } = openAndMount({ count: 1 });
    expect(input(root, 'Contents page').disabled).toBe(true);
    expect(root.textContent).toMatch(/needs more than one document/);
  });

  it('re-disables it when the scope narrows to one deliverable', () => {
    const { root } = openAndMount({ count: 4 });
    expect(input(root, 'Contents page').disabled).toBe(false);
    act(() => {
      input(root, 'This deliverable').click();
    });
    expect(input(root, 'Contents page').disabled).toBe(true);
  });

  it('cancel changes nothing and reports nothing', () => {
    const { root, confirmed } = openAndMount();
    act(() => {
      input(root, 'Check verdict').click();
    });
    act(() => {
      [...root.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    });
    expect(confirmed).toHaveLength(0);
    expect(store.pdfOptions.value).toEqual({ contents: true, verdicts: false });
  });
});

describe('setPdfOptions', () => {
  it('coerces to booleans and drops unknown keys', () => {
    // Deliberately wrong shapes and an unknown key — the assertion is that they are ignored.
    store.setPdfOptions({ contents: 1, states: '', verdicts: true, bogus: 'x' } as any);
    expect(store.pdfOptions.value).toEqual({ contents: true, verdicts: true });
    expect('bogus' in store.pdfOptions.value).toBe(false);
  });
});

describe('the dialog says what it can and cannot do', () => {
  it('is honest that the extension cannot write the file itself', () => {
    const { root } = openAndMount();
    expect(root.textContent).toMatch(/Save as PDF/);
    expect(root.textContent).toMatch(/cannot write the file itself/);
  });
});
