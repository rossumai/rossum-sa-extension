// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { openDataOperations } from '../src/mdh/components/DataOperations.jsx';
import { modalContent } from '../src/mdh/store.js';

beforeEach(() => { modalContent.value = null; });

describe('openDataOperations CSV routing', () => {
  it('opens a modal titled "Insert from CSV file" for insert-csv-file', () => {
    openDataOperations('insert-csv-file', () => {}, () => []);
    expect(modalContent.value).toBeTruthy();
    expect(modalContent.value.title).toBe('Insert from CSV file');
    // render() the modal body to confirm it mounts the CSV wizard (pick stage).
    const node = modalContent.value.render();
    expect(node).toBeTruthy();
  });

  it('still opens the JSON wizard for insert-file', () => {
    openDataOperations('insert-file', () => {}, () => []);
    expect(modalContent.value.title).toBe('Insert from File');
  });
});
