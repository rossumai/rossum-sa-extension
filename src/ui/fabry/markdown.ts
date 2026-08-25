// Hand-rolled markdown subset → block tree. Never produces HTML strings —
// FabryMarkdown.jsx renders the tree as vnodes, so output is XSS-inert by
// construction. Tolerates streaming-partial input: an unterminated fence
// becomes code-so-far; unmatched inline markers render literally.
// Subset by design: no nesting inside strong/em, no md images, http(s) links
// only, one list level.

const SAFE_HREF = /^https?:\/\//i;

export function parseInline(text: unknown): any[] {
  const spans = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      spans.push({ type: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      spans.push({ type: 'code', text: m[1] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
      flush();
      spans.push({ type: 'strong', text: m[1] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\*([^*\s][^*]*)\*/))) {
      flush();
      spans.push({ type: 'em', text: m[1] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\[([^\]]+)\]\(/))) {
      // Balanced-paren scan for the href: a plain [^\s]+ regex either swallows a
      // trailing prose paren (into the link's `)` closer) or, if tightened to
      // [^)\s]+, breaks the XSS-literal-fallback case and Wikipedia-style URLs
      // that legitimately contain parens. Track depth starting at 1 (for the
      // opening paren just consumed); whitespace before depth reaches 0 means
      // this isn't a link after all — fall through to literal char consumption
      // so streaming-partial input still degrades gracefully.
      let depth = 1;
      let j = m[0].length;
      while (j < rest.length && depth > 0) {
        const ch = rest[j];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        else if (/\s/.test(ch)) {
          depth = -1;
          break;
        }
        j += 1;
      }
      if (depth === 0) {
        const href = rest.slice(m[0].length, j - 1);
        const whole = rest.slice(0, j);
        flush();
        if (SAFE_HREF.test(href)) spans.push({ type: 'link', text: m[1], href });
        else spans.push({ type: 'text', text: whole });
        i += whole.length;
        continue;
      }
    }
    buf += s[i];
    i += 1;
  }
  flush();
  return spans;
}

const LIST_UL = /^\s*[-*+]\s+(.*)$/;
const LIST_OL = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
// A paragraph run breaks on any line that starts a different block.
const PARA_BREAK = /^(```|#{1,4}\s|>|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*\|)/;

export function parseMarkdown(text: unknown): any[] {
  const blocks = [];
  const lines = String(text ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if ((m = line.match(/^```(\w*)\s*$/))) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence (absent while streaming)
      blocks.push({ type: 'code', lang: m[1] || '', text: buf.join('\n') });
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      blocks.push({ type: 'heading', level: m[1].length, spans: parseInline(m[2]) });
      i += 1;
      continue;
    }
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      const buf = [m[1]];
      i += 1;
      while (i < lines.length && (m = lines[i].match(/^>\s?(.*)$/))) {
        buf.push(m[1]);
        i += 1;
      }
      blocks.push({ type: 'blockquote', spans: parseInline(buf.join(' ')) });
      continue;
    }
    if (LIST_UL.test(line) || LIST_OL.test(line)) {
      const ordered = LIST_OL.test(line);
      const itemRe = ordered ? LIST_OL : LIST_UL;
      const items = [];
      while (i < lines.length && (m = lines[i].match(itemRe))) {
        items.push(parseInline(m[1]));
        i += 1;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (
      TABLE_ROW.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])
    ) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c: string) => parseInline(c.trim()));
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !PARA_BREAK.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'para', spans: parseInline(buf.join(' ')) });
  }
  return blocks;
}
