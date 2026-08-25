import { describe, it, expect } from 'vitest';
import { serialToDate, dateToSerial, isDateFormat, BUILTIN_DATE_FMT_IDS } from '../src/mdh/xlsxDates.js';

describe('serial <-> date (1900 system)', () => {
  it('maps 45292 to 2024-01-01 UTC', () => {
    expect(serialToDate(45292).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
  it('round-trips a date through a serial', () => {
    const d = new Date('2024-01-15T00:00:00.000Z');
    expect(dateToSerial(d)).toBe(45306);
    expect(serialToDate(45306).toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });
  it('handles fractional time-of-day', () => {
    expect(serialToDate(45292.5).toISOString()).toBe('2024-01-01T12:00:00.000Z');
  });
});

describe('serial <-> date (1904 system)', () => {
  it('is offset by 1462 days', () => {
    expect(serialToDate(45292 - 1462, { date1904: true }).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(dateToSerial(new Date('2024-01-01T00:00:00.000Z'), { date1904: true })).toBe(45292 - 1462);
  });
});

describe('isDateFormat', () => {
  it('treats builtin date ids as dates', () => {
    for (const id of [14, 15, 16, 17, 22, 45, 46, 47]) expect(isDateFormat(id)).toBe(true);
    expect(BUILTIN_DATE_FMT_IDS.has(14)).toBe(true);
  });
  it('treats builtin general/number ids as not dates', () => {
    for (const id of [0, 1, 2, 3, 4, 9, 10, 49]) expect(isDateFormat(id)).toBe(false);
  });
  it('detects date tokens in a custom format code', () => {
    expect(isDateFormat(164, 'yyyy-mm-dd hh:mm:ss')).toBe(true);
    expect(isDateFormat(165, 'dd/mm/yyyy')).toBe(true);
  });
  it('ignores tokens inside quotes / brackets / escapes for non-date custom codes', () => {
    expect(isDateFormat(166, '#,##0.00')).toBe(false);
    expect(isDateFormat(167, '"days: "0')).toBe(false);
    expect(isDateFormat(168, '0.0%')).toBe(false);
    expect(isDateFormat(169, '[Red]-#,##0')).toBe(false);
  });
});
