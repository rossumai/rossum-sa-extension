// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { openImport } from '../src/mdh/components/DataOperations.jsx';
import { modalContent } from '../src/mdh/store.js';

beforeEach(() => {
  modalContent.value = null;
});

describe('import routing', () => {
  it('openImport opens the "Import" modal and mounts the wizard', () => {
    openImport(
      () => {},
      () => [],
    );
    expect(modalContent.value).toBeTruthy();
    expect(modalContent.value!.title).toBe('Import');
    expect(modalContent.value!.render()).toBeTruthy();
  });
});
