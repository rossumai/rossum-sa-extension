// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { recordIdKey, isRecordSelected, toggleRecordSelection } from '../src/mdh/recordSelection.js';
import { selectedIds } from '../src/mdh/store.js';

beforeEach(() => {
  selectedIds.value = new Map();
});

describe('recordIdKey', () => {
  it('returns $oid string for ObjectId records', () => {
    expect(recordIdKey({ _id: { $oid: 'abc' } })).toBe('abc');
  });

  it('returns stringified _id for plain-string records', () => {
    expect(recordIdKey({ _id: 'x' })).toBe('x');
  });

  it('returns stringified _id for numeric _id', () => {
    expect(recordIdKey({ _id: 42 })).toBe('42');
  });
});

describe('isRecordSelected', () => {
  it('returns false when record is not selected', () => {
    expect(isRecordSelected({ _id: { $oid: 'abc' } })).toBe(false);
  });

  it('returns true when record is selected', () => {
    selectedIds.value = new Map([['abc', { $oid: 'abc' }]]);
    expect(isRecordSelected({ _id: { $oid: 'abc' } })).toBe(true);
  });
});

describe('toggleRecordSelection', () => {
  it('adds a record to selectedIds when not selected', () => {
    const record = { _id: { $oid: 'abc' } };
    toggleRecordSelection(record);
    expect(selectedIds.value.has('abc')).toBe(true);
    expect(selectedIds.value.get('abc')).toEqual({ $oid: 'abc' });
  });

  it('removes a record from selectedIds when already selected', () => {
    const record = { _id: { $oid: 'abc' } };
    selectedIds.value = new Map([['abc', { $oid: 'abc' }]]);
    toggleRecordSelection(record);
    expect(selectedIds.value.has('abc')).toBe(false);
  });

  it('add then remove leaves selectedIds empty', () => {
    const record = { _id: 'x' };
    toggleRecordSelection(record);
    expect(selectedIds.value.has('x')).toBe(true);
    toggleRecordSelection(record);
    expect(selectedIds.value.has('x')).toBe(false);
    expect(selectedIds.value.size).toBe(0);
  });
});
