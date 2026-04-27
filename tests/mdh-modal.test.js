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
import { modalContent } from '../src/mdh/store.js';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Modal, null), root);
  return root;
}

function rerender(root) {
  render(h(Modal, null), root);
}

describe('openModal / closeModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    modalContent.value = null;
  });

  it('openModal sets store value with title and render fn', () => {
    const rfn = () => h('div', { class: 'my-body' }, 'hi');
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
    expect(root.querySelector('.modal-overlay')).toBeNull();
  });

  it('renders title and body when a modal is open', () => {
    const root = mount();
    openModal('My Modal', () => h('div', { class: 'modal-body' }, 'body-text'));
    rerender(root);

    expect(root.querySelector('.modal-title').textContent).toBe('My Modal');
    expect(root.querySelector('.modal-body').textContent).toBe('body-text');
  });

  it('close button clears the modal', () => {
    const root = mount();
    openModal('Close Me', () => h('div', null));
    rerender(root);

    root.querySelector('.modal-close').click();
    expect(modalContent.value).toBeNull();
  });

  it('clicking the overlay (outside the card) closes the modal', () => {
    const root = mount();
    openModal('Overlay', () => h('div', null));
    rerender(root);

    const overlay = root.querySelector('.modal-overlay');
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modalContent.value).toBeNull();
  });

  it('clicking inside the card does NOT close the modal', () => {
    const root = mount();
    openModal('Safe', () => h('div', { class: 'inner' }, 'inside'));
    rerender(root);

    root.querySelector('.inner').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modalContent.value).not.toBeNull();
  });

  it('Escape key closes the modal', () => {
    const root = mount();
    openModal('Esc', () => h('div', null));
    rerender(root);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modalContent.value).toBeNull();
  });

  it('non-Escape keys do not close the modal', () => {
    const root = mount();
    openModal('Keep', () => h('div', null));
    rerender(root);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(modalContent.value).not.toBeNull();
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

    expect(root.querySelector('.modal-title').textContent).toBe('Delete?');
    expect(root.querySelector('.modal-message').textContent).toBe('Are you sure?');
    const btns = root.querySelectorAll('.modal-actions button');
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toBe('Cancel');
    expect(btns[1].textContent).toBe('Confirm');
  });

  it('Cancel closes without invoking the callback', () => {
    const root = mount();
    const spy = vi.fn();
    confirmModal('T', 'M', spy);
    rerender(root);

    root.querySelectorAll('.modal-actions button')[0].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).toBeNull();
  });

  it('Confirm closes and invokes the callback', () => {
    const root = mount();
    const spy = vi.fn();
    confirmModal('T', 'M', spy);
    rerender(root);

    root.querySelectorAll('.modal-actions button')[1].click();
    expect(spy).toHaveBeenCalledOnce();
    expect(modalContent.value).toBeNull();
  });

  it('returns a Promise that resolves true on Confirm', async () => {
    const root = mount();
    const p = confirmModal('T', 'M');
    rerender(root);
    root.querySelectorAll('.modal-actions button')[1].click();
    await expect(p).resolves.toBe(true);
  });

  it('returns a Promise that resolves false on Cancel', async () => {
    const root = mount();
    const p = confirmModal('T', 'M');
    rerender(root);
    root.querySelectorAll('.modal-actions button')[0].click();
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

    const input = root.querySelector('input.input');
    expect(input.value).toBe('foo');
    expect(input.placeholder).toBe('new name');
    const submitBtn = root.querySelectorAll('.modal-actions button')[1];
    expect(submitBtn.textContent).toBe('Save');
  });

  it('uses btn-primary by default and applies custom submitClass', () => {
    const root = mount();
    promptModal('X', { submitClass: 'btn-danger' }, () => {});
    rerender(root);
    const submit = root.querySelectorAll('.modal-actions button')[1];
    expect(submit.className).toContain('btn-danger');
  });

  it('submit invokes the callback with the trimmed value', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    const input = root.querySelector('input.input');
    input.value = '  new-value  ';
    root.querySelectorAll('.modal-actions button')[1].click();

    expect(spy).toHaveBeenCalledWith('new-value', expect.any(Object));
  });

  it('submit with unchanged initialValue closes the modal without callback', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', { initialValue: 'same' }, spy);
    rerender(root);

    root.querySelectorAll('.modal-actions button')[1].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).toBeNull();
  });

  it('submit with empty value shows a hint and keeps the modal open', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    root.querySelector('input.input').value = '   ';
    root.querySelectorAll('.modal-actions button')[1].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).not.toBeNull();
    expect(root.querySelector('.input-hint').textContent).toBe('Please enter a value');
  });

  it('Enter key submits the form', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    const input = root.querySelector('input.input');
    input.value = 'typed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(spy).toHaveBeenCalledWith('typed', expect.any(Object));
  });

  it('Cancel button closes without calling onSubmit', () => {
    const root = mount();
    const spy = vi.fn();
    promptModal('T', {}, spy);
    rerender(root);

    root.querySelectorAll('.modal-actions button')[0].click();
    expect(spy).not.toHaveBeenCalled();
    expect(modalContent.value).toBeNull();
  });

  it('renders the optional message above the input', () => {
    const root = mount();
    promptModal('T', { message: 'Heads up — read me.' }, () => {});
    rerender(root);
    expect(root.querySelector('.modal-message').textContent).toBe('Heads up — read me.');
  });

  it('Promise resolves to the submitted value when caller closes the modal', async () => {
    const root = mount();
    const p = promptModal('T', {}, (val) => {
      // Caller validates then closes the modal — typical sidebar create flow.
      if (val === 'ok') closeModal();
    });
    rerender(root);
    const input = root.querySelector('input.input');
    input.value = 'ok';
    root.querySelectorAll('.modal-actions button')[1].click();
    await expect(p).resolves.toBe('ok');
  });

  it('Promise resolves to null on Cancel', async () => {
    const root = mount();
    const p = promptModal('T', {}, () => {});
    rerender(root);
    root.querySelectorAll('.modal-actions button')[0].click();
    await expect(p).resolves.toBeNull();
  });
});
