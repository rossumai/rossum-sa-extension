// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import BulkConfirm from '../src/mdh/components/BulkConfirm.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(BulkConfirm, props), root);
  return root;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('BulkConfirm', () => {
  it('one-click mode: enables submit immediately for counts 1–10', () => {
    const onSubmit = vi.fn();
    const root = mount({ count: 5, collection: 'vendors', onSubmit, onCancel: () => {}, submitLabel: 'Delete', submitClass: 'btn-danger' });
    const submit = root.querySelector('[data-testid="bulk-submit"]');
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('count-gate mode: disables submit until typed value matches the count exactly', () => {
    const onSubmit = vi.fn();
    const root = mount({ count: 423, collection: 'vendors', onSubmit, onCancel: () => {}, submitLabel: 'Delete', submitClass: 'btn-danger' });
    const submit = root.querySelector('[data-testid="bulk-submit"]');
    const input = root.querySelector('[data-testid="bulk-confirm-input"]');
    expect(submit.disabled).toBe(true);

    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-testid="bulk-submit"]').disabled).toBe(true);

    input.value = '423';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-testid="bulk-submit"]').disabled).toBe(false);
  });

  it('count-gate mode: rejects values with commas, decimals, or non-digits', () => {
    const root = mount({ count: 1000, collection: 'c', onSubmit: () => {}, onCancel: () => {}, submitLabel: 'X', submitClass: 'btn-danger' });
    const input = root.querySelector('[data-testid="bulk-confirm-input"]');
    const get = () => root.querySelector('[data-testid="bulk-submit"]').disabled;

    input.value = '1,000'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(get()).toBe(true);

    input.value = '1000.0'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(get()).toBe(true);

    input.value = '  1000  '; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(get()).toBe(false); // whitespace trimmed
  });

  it('name-gate mode (count > 1000): requires the collection name verbatim', () => {
    const root = mount({ count: 5000, collection: 'vendors_eu', onSubmit: () => {}, onCancel: () => {}, submitLabel: 'Delete', submitClass: 'btn-danger' });
    const input = root.querySelector('[data-testid="bulk-confirm-input"]');
    const get = () => root.querySelector('[data-testid="bulk-submit"]').disabled;
    expect(get()).toBe(true);

    input.value = 'vendors'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(get()).toBe(true);

    input.value = 'VENDORS_EU'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(get()).toBe(true); // case-sensitive

    input.value = 'vendors_eu'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(get()).toBe(false);
  });

  it('forceNameGate=true escalates to name gate even when count is small', () => {
    const root = mount({ count: 5, collection: 'c', forceNameGate: true, onSubmit: () => {}, onCancel: () => {}, submitLabel: 'Delete', submitClass: 'btn-danger' });
    const submit = root.querySelector('[data-testid="bulk-submit"]');
    const input = root.querySelector('[data-testid="bulk-confirm-input"]');
    expect(submit.disabled).toBe(true);
    input.value = 'c'; input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-testid="bulk-submit"]').disabled).toBe(false);
  });

  it('Cancel button calls onCancel', () => {
    const onCancel = vi.fn();
    const root = mount({ count: 1, collection: 'c', onSubmit: () => {}, onCancel, submitLabel: 'X', submitClass: 'btn-danger' });
    root.querySelector('[data-testid="bulk-cancel"]').click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disabled prop blocks submit even in one-click mode', () => {
    const onSubmit = vi.fn();
    const root = mount({ count: 1, collection: 'c', disabled: true, onSubmit, onCancel: () => {}, submitLabel: 'X', submitClass: 'btn-danger' });
    const submit = root.querySelector('[data-testid="bulk-submit"]');
    expect(submit.disabled).toBe(true);
  });

  it('count=null disables submit (count-probe failed)', () => {
    const root = mount({ count: null, collection: 'c', onSubmit: () => {}, onCancel: () => {}, submitLabel: 'X', submitClass: 'btn-danger' });
    expect(root.querySelector('[data-testid="bulk-submit"]').disabled).toBe(true);
  });
});
