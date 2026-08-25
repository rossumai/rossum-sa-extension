// @vitest-environment jsdom
//
// E2E test for NetSuite content script: sets up realistic DOM with
// form labels containing onclick handlers, imports the module, and
// verifies that field IDs are extracted and displayed.
//
import { describe, it, expect, beforeAll } from 'vitest';

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe('NetSuite content script', () => {
  beforeAll(async () => {
    // Mock chrome.storage.local
    globalThis.chrome = {
      storage: {
        local: {
          get: () => Promise.resolve({ netsuiteFieldNamesEnabled: true }),
        },
      } as any,
    } as any;

    // Set up realistic NetSuite form DOM:
    // <span id="custbody_field_lbl"><a onclick="nlFieldHelp('TRANSACTION','custbody_my_field')">My Field</a></span>

    const labels = [
      {
        spanId: 'custbody_invoice_num_lbl',
        onclick: "nlFieldHelp('TRANSACTION','custbody_invoice_num')",
        text: 'Invoice Number',
      },
      {
        spanId: 'entity_lbl',
        onclick: "nlFieldHelp('TRANSACTION','entity')",
        text: 'Customer',
      },
      {
        spanId: 'trandate_lbl',
        onclick: "nlFieldHelp('TRANSACTION','trandate')",
        text: 'Date',
      },
      {
        spanId: 'no_onclick_lbl',
        onclick: null,
        text: 'No Handler',
      },
      {
        spanId: 'other_handler_lbl',
        onclick: "someOtherFunc('foo','bar')",
        text: 'Other Handler',
      },
    ];

    for (const { spanId, onclick, text } of labels) {
      const span = document.createElement('span');
      span.id = spanId;

      const link = document.createElement('a');
      link.textContent = text;
      if (onclick) link.setAttribute('onclick', onclick);

      span.appendChild(link);
      document.body.appendChild(span);
    }

    // Import triggers the module's top-level code
    await import('../src/netsuite/index.js');
    await flushPromises();
  });

  const MARKER = 'rossum-sa-extension-netsuite-field-name';

  it('extracts and displays field ID from nlFieldHelp onclick', () => {
    const span = document.getElementById('custbody_invoice_num_lbl');
    const link = span!.querySelector('a');
    const annotation = link!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toBe('custbody_invoice_num');
  });

  it('handles standard field names (single-word)', () => {
    const span = document.getElementById('entity_lbl');
    const link = span!.querySelector('a');
    const annotation = link!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toBe('entity');
  });

  it('handles date field', () => {
    const span = document.getElementById('trandate_lbl');
    const annotation = span!.querySelector(`.${MARKER}`);
    expect(annotation).not.toBeNull();
    expect(annotation!.textContent).toBe('trandate');
  });

  it('ignores links without onclick handler', () => {
    const span = document.getElementById('no_onclick_lbl');
    const annotation = span!.querySelector(`.${MARKER}`);
    expect(annotation).toBeNull();
  });

  it('ignores links with non-nlFieldHelp onclick', () => {
    const span = document.getElementById('other_handler_lbl');
    const annotation = span!.querySelector(`.${MARKER}`);
    expect(annotation).toBeNull();
  });

  it('injects CSS styles', () => {
    const styles = document.head.querySelectorAll('style');
    const hasMarkerStyle = [...styles].some((s) => s.textContent.includes(MARKER));
    expect(hasMarkerStyle).toBe(true);
  });
});
