import { readDocument } from '../src/rossum/annotate/propose.js';
import { it, expect, vi } from 'vitest';

it('readDocument sends the reading prompt with images and returns parsed reading + chatId', async () => {
  const gathered = {
    fields: [{ datapointId: 1, schemaId: 'd', value: 'old', position: [10, 10, 30, 20], page: 1, inLineItem: false }],
    schemaFields: [{ schemaId: 'd', label: 'D', type: 'string', options: null }],
    multivalues: { line_items: 900 },
    tableColumns: { line_items: ['item_quantity'] },
    pageImages: [{ mediaType: 'image/png', data: 'B64' }],
    ocrPages: [],
  };
  const streamFabry = vi.fn(async ({ content, images, onEvent }) => {
    expect(content).toMatch(/verbatim/i);
    expect(content).toContain('line_items: item_quantity');
    expect(images).toEqual([{ media_type: 'image/png', data: 'B64' }]);
    onEvent({ type: 'text-delta', delta: '```json\n{"headers":[{"schema_id":"d","value":"INV-1","printed":"INV-1","page":1}],"tables":[]}\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  const out = await readDocument({ gathered, token: 't', domain: 'https://x.rossum.app', streamFabry });
  expect(out.chatId).toBe('c1');
  expect(out.reading.headers[0]).toMatchObject({ schemaId: 'd', value: 'INV-1', printed: 'INV-1' });
});

it('readDocument returns a null reading for an unparseable reply', async () => {
  const gathered = { fields: [], schemaFields: [], multivalues: {}, tableColumns: {}, pageImages: [], ocrPages: [] };
  const streamFabry = vi.fn(async ({ onEvent }) => {
    onEvent({ type: 'text-delta', delta: 'I cannot read this document.' });
    onEvent({ type: '__done__' });
    return { chatId: 'c2' };
  });
  const out = await readDocument({ gathered, token: 't', domain: 'https://x.rossum.app', streamFabry });
  expect(out.reading).toBeNull();
  expect(out.chatId).toBe('c2');
});
