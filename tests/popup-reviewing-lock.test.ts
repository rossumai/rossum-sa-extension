import { describe, it, expect } from 'vitest';
import { isLockedByOther, pickHolderName } from '../src/popup/reviewingLock.js';

const ME = 'https://api.example.com/api/v1/users/1';
const OTHER = 'https://api.example.com/api/v1/users/2';

describe('isLockedByOther', () => {
  it('is true only for reviewing + a different modified_by', () => {
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: OTHER, meUrl: ME })).toBe(true);
  });
  it('is false when I am the modifier (I hold it elsewhere)', () => {
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: ME, meUrl: ME })).toBe(false);
  });
  it('is false for any non-reviewing status', () => {
    for (const status of ['to_review', 'confirmed', 'exported', 'importing', 'deleted']) {
      expect(isLockedByOther({ status, modifiedBy: OTHER, meUrl: ME })).toBe(false);
    }
  });
  it('is false (never guess) when modified_by or meUrl is missing', () => {
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: null, meUrl: ME })).toBe(false);
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: OTHER, meUrl: undefined })).toBe(false);
  });
});

describe('pickHolderName', () => {
  it('prefers the plain full name (no username suffix)', () => {
    expect(pickHolderName({ first_name: 'Jane', last_name: 'Doe', username: 'jd@x.com' }))
      .toBe('Jane Doe');
    expect(pickHolderName({ first_name: 'Jane', last_name: 'Doe' })).toBe('Jane Doe');
  });
  it('falls back to the username when there is no name', () => {
    expect(pickHolderName({ first_name: '', last_name: '', username: 'jd@x.com' })).toBe('jd@x.com');
  });
  it('falls back to "another user" for null/empty', () => {
    expect(pickHolderName(null)).toBe('another user');
    expect(pickHolderName({})).toBe('another user');
  });
});
