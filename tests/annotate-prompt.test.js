import { describe, it, expect } from 'vitest';
import { buildFixPrompt } from '../src/rossum/annotate/prompt.js';

// The main document turn is the READING (reading.js) — prompt.js now carries
// only the validation-refine prompt.

describe('buildFixPrompt', () => {
  it('lists remaining errors with dp# and asks for datapoint_id-keyed json', () => {
    const p = buildFixPrompt({
      errors: [{ type: 'error', content: 'not in master data', datapointId: 11, schemaId: 'item_amount' }],
      fields: [{ datapointId: 11, schemaId: 'item_amount', value: 'b', position: null, page: 1, confidence: 0.4, rowIndex: 2, inLineItem: true }],
      schemaFields: [],
    });
    expect(p).toContain('dp#11');
    expect(p).toContain('not in master data');
    expect(p).toContain('(current value="b", row 2)');
    expect(p).toMatch(/datapoint_id/);
    expect(p).toMatch(/json/i);
    expect(p).toMatch(/NOTHING else/); // brevity contract
  });
  it('stays within the char budget', () => {
    const errors = Array.from({ length: 2000 }, (_, i) => ({ type: 'error', content: 'e'.repeat(50), datapointId: i, schemaId: 'f' + i }));
    const p = buildFixPrompt({ errors, fields: [], schemaFields: [], maxChars: 2000 });
    expect(p.length).toBeLessThanOrEqual(2000);
  });
});
