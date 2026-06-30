// Pure Excel date helpers, shared by the .xlsx reader (xlsx.js) and writer
// (xlsxWrite.js). Excel stores a date as a number (a "serial") + a display
// number-format; the serial is days since the system epoch. The 1900-system
// constant 25569 coincides with the Excel serial of the Unix epoch, so it is
// correct for every date >= 1900-03-01 (the pre-1900-03-01 Excel leap-year-bug
// region is not corrected — no real master data lives there).

const MS_PER_DAY = 86400000;
export const EPOCH_1900 = 25569; // days from 1899-12-30 to 1970-01-01
export const EPOCH_1904 = 24107; // days from 1904-01-01 to 1970-01-01

export function serialToDate(serial, { date1904 = false } = {}) {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  return new Date(Math.round((serial - epoch) * MS_PER_DAY));
}

export function dateToSerial(date, { date1904 = false } = {}) {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  return date.getTime() / MS_PER_DAY + epoch;
}

// Builtin number-format ids that represent dates/times (ECMA-376 §18.8.30).
export const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

// A custom format (numFmtId >= 164) is a date if, after removing quoted
// literals, escaped chars, and bracketed sections (colors/locales/conditions),
// it still contains a y/m/d/h/s token.
export function isDateFormat(numFmtId, formatCode) {
  if (BUILTIN_DATE_FMT_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  const stripped = formatCode
    .replace(/"[^"]*"/g, '')      // quoted literals
    .replace(/\\./g, '')          // escaped char
    .replace(/\[[^\]]*\]/g, '');  // [Red], [$-409], [>0] ...
  return /[ymdhs]/i.test(stripped);
}
