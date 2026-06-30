// src/mdh/specialChars.js
// Pure, DOM-free classification of "special" characters in record values:
// invisible characters, non-standard whitespace, and control characters —
// everything EXCEPT the ordinary ASCII space (U+0020). Consumed by
// components/SpecialText.jsx to reveal characters the browser would otherwise
// hide. Kept as a plain .js module (like displayValue.js) so it can be
// unit-tested without a JSX loader.

const SPACE_CPS = new Set([
  0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a,
  0x202f, 0x205f, 0x3000,
]);

const ZERO_WIDTH_CPS = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e,
]);

const BIDI_CPS = new Set([
  0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

const NAMES = {
  0x00a0: 'NO-BREAK SPACE', 0x1680: 'OGHAM SPACE MARK',
  0x2000: 'EN QUAD', 0x2001: 'EM QUAD', 0x2002: 'EN SPACE', 0x2003: 'EM SPACE',
  0x2004: 'THREE-PER-EM SPACE', 0x2005: 'FOUR-PER-EM SPACE',
  0x2006: 'SIX-PER-EM SPACE', 0x2007: 'FIGURE SPACE',
  0x2008: 'PUNCTUATION SPACE', 0x2009: 'THIN SPACE', 0x200a: 'HAIR SPACE',
  0x202f: 'NARROW NO-BREAK SPACE', 0x205f: 'MEDIUM MATHEMATICAL SPACE',
  0x3000: 'IDEOGRAPHIC SPACE',
  0x200b: 'ZERO WIDTH SPACE', 0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER', 0x2060: 'WORD JOINER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE', 0x00ad: 'SOFT HYPHEN',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x0009: 'TAB', 0x000a: 'LINE FEED', 0x000b: 'LINE TABULATION',
  0x000c: 'FORM FEED', 0x000d: 'CARRIAGE RETURN', 0x0085: 'NEXT LINE',
  0x001c: 'FILE SEPARATOR', 0x001d: 'GROUP SEPARATOR',
  0x001e: 'RECORD SEPARATOR', 0x001f: 'UNIT SEPARATOR',
  0x007f: 'DELETE', 0x2028: 'LINE SEPARATOR', 0x2029: 'PARAGRAPH SEPARATOR',
  0x200e: 'LEFT-TO-RIGHT MARK', 0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING', 0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING', 0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE',
};

// Short, uppercase abbreviations shown as the marker label (e.g. "NBSP").
// Characters without a curated abbreviation fall back to their cpLabel ("U+XXXX").
const ABBR = {
  0x00a0: 'NBSP', 0x1680: 'OGSP',
  0x2000: 'NQSP', 0x2001: 'MQSP', 0x2002: 'ENSP', 0x2003: 'EMSP',
  0x2004: '3MSP', 0x2005: '4MSP', 0x2006: '6MSP', 0x2007: 'FIGSP',
  0x2008: 'PUNSP', 0x2009: 'THSP', 0x200a: 'HRSP',
  0x202f: 'NNBSP', 0x205f: 'MMSP', 0x3000: 'IDSP',
  0x200b: 'ZWSP', 0x200c: 'ZWNJ', 0x200d: 'ZWJ', 0x2060: 'WJ',
  0xfeff: 'BOM', 0x00ad: 'SHY', 0x180e: 'MVS',
  0x0009: 'TAB', 0x000a: 'LF', 0x000b: 'VT', 0x000c: 'FF',
  0x000d: 'CR', 0x0085: 'NEL', 0x007f: 'DEL',
  0x001c: 'FS', 0x001d: 'GS', 0x001e: 'RS', 0x001f: 'US',
  0x2028: 'LSEP', 0x2029: 'PSEP',
  0x200e: 'LRM', 0x200f: 'RLM',
  0x202a: 'LRE', 0x202b: 'RLE', 0x202c: 'PDF', 0x202d: 'LRO', 0x202e: 'RLO',
  0x2066: 'LRI', 0x2067: 'RLI', 0x2068: 'FSI', 0x2069: 'PDI',
};

export function cpLabel(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function isControl(cp) {
  return cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
    || cp === 0x2028 || cp === 0x2029;
}

export function classifySpecial(cp) {
  if (cp === 0x20) return null; // ordinary space is never special
  const abbr = ABBR[cp] || cpLabel(cp);
  if (SPACE_CPS.has(cp)) return { category: 'space', name: NAMES[cp] || 'SPACE', abbr };
  if (ZERO_WIDTH_CPS.has(cp)) return { category: 'zero-width', name: NAMES[cp] || 'ZERO WIDTH', abbr };
  if (BIDI_CPS.has(cp)) return { category: 'bidi', name: NAMES[cp] || 'BIDI CONTROL', abbr };
  if (isControl(cp)) return { category: 'control', name: NAMES[cp] || ('CONTROL ' + cpLabel(cp)), abbr };
  return null;
}

export function hasSpecial(str) {
  if (typeof str !== 'string') return false;
  for (const ch of str) {
    if (classifySpecial(ch.codePointAt(0))) return true;
  }
  return false;
}

export function tokenizeSpecial(str, { limit } = {}) {
  const tokens = [];
  let buf = '';
  let count = 0;
  let truncated = false;
  const flush = () => { if (buf) { tokens.push({ type: 'text', value: buf }); buf = ''; } };
  for (const ch of str) {
    if (limit != null && count >= limit) { truncated = true; break; }
    const cp = ch.codePointAt(0);
    const info = classifySpecial(cp);
    if (info) {
      flush();
      tokens.push({ type: 'special', cp, char: ch, category: info.category, name: info.name, abbr: info.abbr });
    } else {
      buf += ch;
    }
    count += 1;
  }
  flush();
  return { tokens, truncated };
}
