// @vitest-environment jsdom
//
// E2E test for Coupa content script: sets up realistic DOM, imports
// the module (which triggers execution), and verifies field annotations.
//
import { describe, it, expect, beforeAll } from 'vitest';

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe('Coupa content script', () => {
  beforeAll(async () => {
    // Mock chrome.storage.local
    globalThis.chrome = {
      storage: {
        local: {
          get: () => Promise.resolve({ coupaFieldNamesEnabled: true }),
        },
      } as any,
    } as any;

    // ── Strategy 1: JSON metadata (React invoice pages) ──

    const script = document.createElement('script');
    script.id = 'initial_full_react_data';
    script.type = 'application/json';
    script.textContent = JSON.stringify({
      metadata: {
        header_section: {
          f1: { label: 'Invoice Number', name: 'invoice-number' },
          f2: { label: 'Supplier', name: 'account-name' },
        },
        lines_section: {
          lines: [
            {
              f3: { label: 'Quantity', name: 'quantity' },
              f4: { label: 'Unit Price', name: 'price' },
            },
          ],
        },
        summary_section: {
          tax_lines: [{ label: 'Tax Amount', name: 'tax-amount' }],
        },
      },
    });
    document.body.appendChild(script);

    // Create label elements matching JSON strategy selectors
    const jsonLabels = [
      { tag: 'dt', cls: 'label_readonly', text: 'Invoice Number', expected: 'invoice-number' },
      { tag: 'dt', cls: 'group_label', text: 'Supplier', expected: 'account-name' },
      { tag: 'dt', cls: 'label_readonly', text: 'Quantity', expected: 'quantity' },
      { tag: 'dt', cls: 'label_readonly', text: 'Tax Amount', expected: 'tax-amount' },
    ];

    for (const { tag, cls, text } of jsonLabels) {
      const el = document.createElement(tag);
      el.className = cls;
      el.textContent = text;
      el.dataset.testId = text;
      document.body.appendChild(el);
    }

    // ── Strategy 2: Rails DOM extraction (PO pages) ──

    // 2a: ID-based extraction (order_header_*)
    const formEl1 = document.createElement('div');
    formEl1.className = 'form_element';
    const label1 = document.createElement('label');
    label1.className = 'group_label';
    label1.textContent = 'Ship To';
    label1.dataset.testId = 'Ship To';
    const input1 = document.createElement('input');
    input1.id = 'order_header_ship_to_address';
    formEl1.appendChild(label1);
    formEl1.appendChild(input1);
    document.body.appendChild(formEl1);

    // 2b: s-class extraction
    const formEl2 = document.createElement('div');
    formEl2.className = 'form_element';
    const label2 = document.createElement('span');
    label2.className = 'group_label';
    label2.textContent = 'Payment Term';
    label2.dataset.testId = 'Payment Term';
    const child2 = document.createElement('div');
    child2.className = 's-paymentTermCode';
    formEl2.appendChild(label2);
    formEl2.appendChild(child2);
    document.body.appendChild(formEl2);

    // 2c: orderLine semantic class
    const formEl3 = document.createElement('div');
    formEl3.className = 'form_element orderLineQuantity';
    const label3 = document.createElement('span');
    label3.className = 'group_label';
    label3.textContent = 'Qty';
    label3.dataset.testId = 'Qty';
    formEl3.appendChild(label3);
    document.body.appendChild(formEl3);

    // 2d: s-class from IGNORE list should be skipped
    const formEl4 = document.createElement('div');
    formEl4.className = 'form_element';
    const label4 = document.createElement('span');
    label4.className = 'group_label';
    label4.textContent = 'Ignored';
    label4.dataset.testId = 'Ignored';
    const child4 = document.createElement('div');
    child4.className = 's-header'; // in IGNORE_S_CLASSES
    formEl4.appendChild(label4);
    formEl4.appendChild(child4);
    document.body.appendChild(formEl4);

    // Import triggers the module's top-level code
    await import('../src/coupa/index.js');
    await flushPromises();
  });

  const MARKER = 'rossum-sa-extension-coupa-field-name';

  // ── JSON metadata strategy ──

  it('annotates "Invoice Number" label from JSON metadata', () => {
    const el = document.querySelector('[data-test-id="Invoice Number"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toContain('invoice-number');
  });

  it('annotates "Supplier" label from JSON metadata', () => {
    const el = document.querySelector('[data-test-id="Supplier"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation!.textContent).toContain('account-name');
  });

  it('annotates line-level fields from JSON metadata', () => {
    const el = document.querySelector('[data-test-id="Quantity"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation!.textContent).toContain('quantity');
  });

  it('annotates tax line fields from JSON metadata', () => {
    const el = document.querySelector('[data-test-id="Tax Amount"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation!.textContent).toContain('tax-amount');
  });

  // ── Rails DOM strategy ──

  it('extracts field name from element ID (order_header_*)', () => {
    const el = document.querySelector('[data-test-id="Ship To"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toContain('ship_to_address');
  });

  it('extracts field name from s-class and converts camelCase to snake_case', () => {
    const el = document.querySelector('[data-test-id="Payment Term"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toContain('payment_term_code');
  });

  it('extracts field name from orderLine* semantic class', () => {
    const el = document.querySelector('[data-test-id="Qty"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toContain('quantity');
  });

  it('ignores s-classes in the IGNORE list', () => {
    const el = document.querySelector('[data-test-id="Ignored"]');
    const annotation = el!.querySelector(`.${MARKER}`);
    expect(annotation).toBeNull();
  });

  it('injects CSS styles for annotations', () => {
    const styles = document.head.querySelectorAll('style');
    const hasMarkerStyle = [...styles].some((s) => s.textContent.includes(MARKER));
    expect(hasMarkerStyle).toBe(true);
  });
});
