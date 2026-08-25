// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

// store.js imports chrome during module init via other MDH modules that may
// be transitively reached; guard with a minimal mock.
globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

import Modal, { openModal, closeModal, confirmModal, promptModal } from '../src/mdh/components/Modal.jsx';
import mstyles from '../src/ui/Modal.module.css';
import { modalContent } from '../src/mdh/store.js';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<Modal />, root);
  return root;
}

function rerender(root: any) {
  render(<Modal />, root);
}

describe('openModal / closeModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    modalContent.value = null;
  });

  it('openModal sets store value with title and render fn', () => {
    const rfn = () => <div class="my-body">hi</div>;
    openModal('Hello', rfn);
    expect(modalContent.value).toEqual({ title: 'Hello', render: rfn });
  });

  it('closeModal clears the store value', () => {
    openModal('X', () => null);
    expect(modalContent.value).not.toBeNull();
    closeModal();
    expect(modalContent.value).toBeNull();
  });
});

describe('Modal component', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    modalContent.value = null;
  });

  it('renders nothing when modalContent is null', () => {
    const root = mount();
    expect(root.querySelector(('.' + mstyles.overlay))).toBeNull();
  });

  it('renders title and body when a modal is open', () => {
    const root = mount();
    openModal('My Modal', () => <div class="modal-body">body-text</div>);
    rerender(root);

    expect(root.querySelector(('.' + mstyles.title))!.textContent).toBe('My Modal');
    expect(root.querySelector('.modal-body')!.textContent).toBe('body-text');
  });

  it('close button clears the modal', () => {
    const root = mount();
    openModal('Close Me', () => <div />);
    rerender(root);

    root.querySelector<HTMLElement>(('.' + mstyles.close))!.click();
    expect(modalContent.value).toBeNull();
  });

  it('clicking the overlay (outside the card) closes the modal', () => {
    const root = mount();
    openModal('Overlay', () => <div />);
    rerender(root);

    const overlay = root.querySelector(('.' + mstyles.overlay));
    overlay!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modalContent.value).toBeNull();
  });

  it('clicking inside the card does NOT close the modal', () => {
    const root = mount();
    openModal('Safe', () => <div class="inner">inside</div>);
    rerender(root);

    root.querySelector('.inner')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modalContent.value).not.toBeNull();
  });

  it('Escape key closes the modal', () => {
    const root = mount();
    openModal('Esc', () => <div />);
    rerender(root);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modalContent.value).toBeNull();
  });

  it('non-Escape keys do not close the modal', () => {
    const root = mount();
    openModal('Keep', () => <div />);
    rerender(root);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(modalContent.value).not.toBeNull();
  });

  it('marks the card as a labelled modal dialog', () => {
    const root = mount();
    openModal('My Modal', () => <div />);
    rerender(root);

    const card = root.querySelector(('.' + mstyles.card))!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.getAttribute('aria-labelledby')).toBe('modal-title');
    expect(root.querySelector('#modal-title')!.textContent).toBe('My Modal');
  });

  it('close button has an accessible name', () => {
    const root = mount();
    openModal('X', () => <div />);
    rerender(root);
    expect(root.querySelector(('.' + mstyles.close))!.getAttribute('aria-label')).toBe('Close');
  });

  it('restores focus to the previously-focused element on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const root = mount();
    openModal('Focus', () => <div />);
    rerender(root);

    closeModal();
    rerender(root);

    expect(document.activeElement).toBe(trigger);
  });
});

describe('confirmModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    modalContent.value = null;
  });

  it('renders the message and confirm/cancel buttons', () => {
    const root = mount();
    confirmModal('Delete?', 'Are you sure?', () => {});
    rerender(root);

    expect(root.querySelector(('.' + mstyles.title))!.textContent).toBe('Delete?');
    expect(root.querySelector(('.' + mstyles.message))!.textContent).toBe('Are you sure?');
    const btns = root.querySelectorAll(('.' + mstyles.actions + ' button'));
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toBe('Cancel');
    expect(btns[1].textContent).toBe('Confirm');
  });

  it('Cancel closes without invoking the callback', () => {
    const root = mount();
    const spy = vi.fn();
    confirmModal('T', 'M', spy);
    rerender(root);

    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[0].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).toBeNull();
  });

  it('Confirm closes and invokes the callback', () => {
    const root = mount();
    const spy = vi.fn();
    confirmModal('T', 'M', spy);
    rerender(root);

    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[1].click();
    expect(spy).toHaveBeenCalledOnce();
    expect(modalContent.value).toBeNull();
  });

  it('returns a Promise that resolves true on Confirm', async () => {
    const root = mount();
    const p = confirmModal('T', 'M');
    rerender(root);
    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[1].click();
    await expect(p).resolves.toBe(true);
  });

  it('returns a Promise that resolves false on Cancel', async () => {
    const root = mount();
    const p = confirmModal('T', 'M');
    rerender(root);
    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[0].click();
    await expect(p).resolves.toBe(false);
  });

  it('returns a Promise that resolves false on Escape', async () => {
    const root = mount();
    const p = confirmModal('T', 'M');
    rerender(root);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p).resolves.toBe(false);
  });
});

describe('promptModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    modalContent.value = null;
  });

  it('renders an input with the initial value and custom submit label', () => {
    const root = mount();
    promptModal('Rename', { placeholder: 'new name', initialValue: 'foo', submitLabel: 'Save' }, () => {});
    rerender(root);

    const input = root.querySelector<HTMLInputElement>('input.input')!;
    expect(input.value).toBe('foo');
    expect(input.placeholder).toBe('new name');
    const submitBtn = root.querySelectorAll(('.' + mstyles.actions + ' button'))[1];
    expect(submitBtn.textContent).toBe('Save');
  });

  it('uses btn-primary by default and applies custom submitClass', () => {
    const root = mount();
    promptModal('X', { submitClass: 'btn-danger' }, () => {});
    rerender(root);
    const submit = root.querySelectorAll(('.' + mstyles.actions + ' button'))[1];
    expect(submit.className).toContain('btn-danger');
  });

  it('submit invokes the callback with the trimmed value', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    const input = root.querySelector<HTMLInputElement>('input.input');
    input!.value = '  new-value  ';
    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[1].click();

    expect(spy).toHaveBeenCalledWith('new-value', expect.any(Object));
  });

  it('submit with unchanged initialValue closes the modal without callback', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', { initialValue: 'same' }, spy);
    rerender(root);

    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[1].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).toBeNull();
  });

  it('submit with empty value shows a hint and keeps the modal open', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    root.querySelector<HTMLInputElement>('input.input')!.value = '   ';
    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[1].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).not.toBeNull();
    expect(root.querySelector('.input-hint')!.textContent).toBe('Please enter a value');
  });

  it('Enter key submits the form', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    const input = root.querySelector<HTMLInputElement>('input.input')!;
    input.value = 'typed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(spy).toHaveBeenCalledWith('typed', expect.any(Object));
  });

  it('Cancel button closes without calling onSubmit', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[0].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).toBeNull();
  });

  it('renders the optional message above the input', () => {
    const root = mount();
    promptModal('T', { message: 'Heads up — read me.' }, () => {});
    rerender(root);
    expect(root.querySelector(('.' + mstyles.message))!.textContent).toBe('Heads up — read me.');
  });

  it('Promise resolves to the submitted value when caller closes the modal', async () => {
    const root = mount();
    const p = promptModal('T', {}, (val) => {
      // Caller validates then closes the modal — typical sidebar create flow.
      if (val === 'ok') closeModal();
    });
    rerender(root);
    const input = root.querySelector<HTMLInputElement>('input.input');
    input!.value = 'ok';
    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[1].click();
    await expect(p).resolves.toBe('ok');
  });

  it('Promise resolves to null on Cancel', async () => {
    const root = mount();
    const p = promptModal('T', {}, () => {});
    rerender(root);
    root.querySelectorAll<HTMLElement>(('.' + mstyles.actions + ' button'))[0].click();
    await expect(p).resolves.toBeNull();
  });
});
