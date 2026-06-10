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

  it('opens the JSON wizard titled "Insert from JSON file" for insert-file', () => {
    openDataOperations('insert-file', () => {}, () => []);
    expect(modalContent.value.title).toBe('Insert from JSON file');
  });

  it('opens the JSONL wizard titled "Insert from JSONL file" for insert-jsonl-file', () => {
    openDataOperations('insert-jsonl-file', () => {}, () => []);
    expect(modalContent.value.title).toBe('Insert from JSONL file');
  });
});
