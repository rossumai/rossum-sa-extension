import { startAnnotation, applyContentOperations, validateContent, parseValidateMessages, cancelAnnotation } from '../src/rossum/annotate/annotationWrite.js';
import { describe, it, expect, vi } from 'vitest';

describe('annotationWrite', () => {
  it('start/apply/validate/cancel hit the right paths', async () => {
    const post = vi.fn((p) => {
      if (p.endsWith('/start')) return Promise.resolve({ annotation: 'u' });
      if (p.endsWith('/content/operations')) return Promise.resolve({ content: [{ id: 1 }] });
      if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
      if (p.endsWith('/cancel')) return Promise.resolve({});
      throw new Error('x ' + p);
    });
    await startAnnotation(5, { post });
    expect(post).toHaveBeenCalledWith('/api/v1/annotations/5/start', {});
    const content = await applyContentOperations(5, [{ op: 'replace', id: 1, value: { content: { value: 'z' } } }], { post });
    expect(content).toEqual([{ id: 1 }]);
    expect(post.mock.calls.find((c) => c[0].endsWith('/content/operations'))[1]).toEqual({ operations: [{ op: 'replace', id: 1, value: { content: { value: 'z' } } }] });
    await validateContent(5, { post });
    await cancelAnnotation(5, { post });
    expect(post).toHaveBeenCalledWith('/api/v1/annotations/5/cancel', {});
  });
  it('parseValidateMessages maps id→datapointId and schema_id', () => {
    expect(parseValidateMessages({ messages: [{ type: 'error', content: 'bad', id: 11, schema_id: 'item_amount' }] }))
      .toEqual([{ type: 'error', content: 'bad', datapointId: 11, schemaId: 'item_amount' }]);
    expect(parseValidateMessages({})).toEqual([]);
  });
});
