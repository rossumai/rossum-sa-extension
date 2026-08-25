import { describe, it, expect } from 'vitest';
import { bootPrefillFor } from '../src/mdh/lastPipeline.js';

describe('bootPrefillFor carries placeholderTypes', () => {
  it('passes through stored placeholderTypes (absent → {})', () => {
    const withTypes = bootPrefillFor(
      { pipelineText: '[]', variables: { a: '1' }, placeholderTypes: { a: 'string' } },
      'col',
      false,
    );
    expect(withTypes!.placeholderTypes).toEqual({ a: 'string' });
    const legacy = bootPrefillFor({ pipelineText: '[]', variables: {} }, 'col', false);
    expect(legacy!.placeholderTypes).toEqual({});
  });
});
