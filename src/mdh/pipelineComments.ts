import JSON5 from 'json5';

const SENTINEL = '@disabled-stage';

// Single string/comment/depth-aware scan of the outer array. Returns ordered
// top-level items: active object-stages (char span) and @disabled-stage block
// comments (span + inner text). Aggregation stages are always objects, so an
// active element is detected as a `{` opened at depth 1.
// Also tracks the outer `[`/`]` positions as arrayStart/arrayEnd.
function scanLayout(text: string) {
  const items = [];
  const n = text.length;
  let i = 0;
  let depth = 0;
  let inString = false;
  let activeStart = -1;
  let arrayStart = -1;
  let arrayEnd = -1;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      const body = text.slice(i + 2, close === -1 ? n : close);
      if (depth === 1 && body.trimStart().startsWith(SENTINEL)) {
        items.push({
          kind: 'disabled',
          start: i,
          end,
          inner: body.trimStart().slice(SENTINEL.length),
        });
      }
      i = end;
      continue;
    }
    if (c === '[' || c === '{') {
      if (depth === 0 && c === '[' && arrayStart === -1) arrayStart = i;
      if (depth === 1 && c === '{') activeStart = i;
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 1 && c === '}' && activeStart >= 0) {
        items.push({ kind: 'active', start: activeStart, end: i + 1 });
        activeStart = -1;
      }
      if (depth === 0 && c === ']' && arrayEnd === -1) arrayEnd = i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { items, arrayStart, arrayEnd };
}

// Lossless document model: one segment per top-level item, carrying its exact
// source span. Gaps (commas/whitespace/comments) are recovered from the original
// text via the spans — the text is the source of truth.
export function parsePipelineDoc(text: string) {
  let top;
  try {
    top = JSON5.parse(text);
  } catch {
    return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 };
  }
  if (!Array.isArray(top)) return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 };
  const { items, arrayStart, arrayEnd } = scanLayout(text);
  const segments = [];
  for (const item of items) {
    if (item.kind === 'active') {
      let stage;
      try {
        stage = JSON5.parse(text.slice(item.start, item.end));
      } catch {
        return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 };
      }
      segments.push({ kind: 'active', start: item.start, end: item.end, stage });
    } else {
      // The disabled block's content keeps the stage's trailing comma (so the
      // comment reads like the original line). Strip it (and unescape `*\/`)
      // before parsing the stage object; `raw` keeps the verbatim content.
      const raw = item.inner!.trim();
      let stage = null;
      try {
        stage = JSON5.parse(raw.replace(/\*\\\//g, '*/').replace(/,\s*$/, ''));
      } catch {
        /* forgiving: keep raw */
      }
      segments.push({ kind: 'disabled', start: item.start, end: item.end, stage, raw });
    }
  }
  const activeCount = segments.filter((s) => s.kind === 'active').length;
  if (activeCount !== top.length) return { ok: false, segments: [], arrayStart: -1, arrayEnd: -1 };
  return { ok: true, segments, arrayStart, arrayEnd };
}

// Parse editor text into ordered entries (derived from the document model).
// Shape is unchanged: disabled entries carry `raw`; active entries do not.
export function parseEntries(text: string): { ok: boolean; entries: any[] } {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok) return { entries: [], ok: false };
  return {
    ok: true,
    entries: segments.map((s) =>
      s.kind === 'disabled'
        ? { disabled: true, stage: s.stage, raw: s.raw }
        : { disabled: false, stage: s.stage },
    ),
  };
}

// Re-indent a JSON.stringify(…, null, 2) body so it sits at a 2-space array
// element: line 0 stays bare (the gap before the splice provides its indent),
// lines 1.. get +2.
function reindentStage(stage: any): string {
  return JSON.stringify(stage, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : '  ' + l))
    .join('\n');
}

// Apply non-overlapping { start, end, replacement } edits to text, right-to-left
// so earlier offsets stay valid.
function applyEdits(text: string, edits: any[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

// Index of the top-level separator comma in text[from, to), skipping whitespace,
// line comments, and block comments. Returns -1 if the first significant char
// is not a comma (e.g. the array end `]` or the next element).
function findSeparatorComma(text: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl === -1 ? to : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? to : close + 2;
      continue;
    }
    if (c === ',') return i;
    return -1;
  }
  return -1;
}

// Toggle one stage disabled/enabled as a single in-place text splice — every
// other byte is preserved. Disabling wraps the stage's VERBATIM span in a
// @disabled-stage block (keeping its formatting + inner comments); enabling
// restores the inner verbatim, even when invalid (the editor then shows the
// parse error). No-op on a bad index or unparseable text.
export function setStageDisabled(text: string, entryIndex: number, disabled: boolean): string {
  const { ok, segments, arrayEnd } = parsePipelineDoc(text);
  if (!ok || entryIndex < 0 || entryIndex >= segments.length) return text;
  const seg = segments[entryIndex];
  const isDisabled = seg.kind === 'disabled';
  if (isDisabled === disabled) return text;
  const scanTo = arrayEnd >= 0 ? arrayEnd : text.length;

  if (disabled) {
    // Indent the body's first line to the stage's column (the leading gap stays,
    // so `/*` sits at that column and the body should align under it), and wrap
    // the stage's TRAILING comma inside the comment so the disabled block reads
    // like the original line. The comma moving into the comment is what keeps the
    // array valid (the preceding separator comma still divides the neighbours).
    const lineStart = text.lastIndexOf('\n', seg.start - 1) + 1;
    const indent = (/^[ \t]*/.exec(text.slice(lineStart, seg.start)) || [''])[0];
    const commaPos = findSeparatorComma(text, seg.end, scanTo);
    const wrapEnd = commaPos !== -1 ? commaPos + 1 : seg.end;
    const body = text.slice(seg.start, wrapEnd).replace(/\*\//g, '*\\/');
    return applyEdits(text, [
      { start: seg.start, end: wrapEnd, replacement: `/* ${SENTINEL}\n${indent}${body} */` },
    ]);
  }

  // enable: restore the inner verbatim. If the content already carries its
  // trailing comma (new-style block), it round-trips as-is. Otherwise (old-style
  // block, or one disabled while last) add separator commas on each side that
  // borders an active stage and doesn't already have one.
  const inner = seg.raw!.replace(/\*\\\//g, '*/');
  if (/,\s*$/.test(inner)) {
    return applyEdits(text, [{ start: seg.start, end: seg.end, replacement: inner }]);
  }
  let prevActiveEnd = -1;
  for (let j = entryIndex - 1; j >= 0; j--) {
    if (segments[j].kind === 'active') {
      prevActiveEnd = segments[j].end;
      break;
    }
  }
  const hasActiveAfter = segments.slice(entryIndex + 1).some((s) => s.kind === 'active');
  const needLead =
    prevActiveEnd !== -1 && findSeparatorComma(text, prevActiveEnd, seg.start) === -1;
  const needTrail = hasActiveAfter && findSeparatorComma(text, seg.end, scanTo) === -1;
  return applyEdits(text, [
    {
      start: seg.start,
      end: seg.end,
      replacement: (needLead ? ',' : '') + inner + (needTrail ? ',' : ''),
    },
  ]);
}

const PLACEHOLDER = '__disabledStagePlaceholder__';

// Edit that removes segment k and exactly one separator comma. When the previous
// segment is ACTIVE the separator comma (and this stage's leading comment, Limit B)
// lives in the leading gap; when k===0 or the predecessor is a DISABLED block (no
// comma in the leading gap) the separator comma is the trailing one.
function removeEdit(
  text: string,
  segments: any[],
  k: number,
  arrayStart: number,
  arrayEnd: number,
) {
  const scanTo = arrayEnd >= 0 ? arrayEnd : text.length;
  if (segments.length === 1)
    return { start: arrayStart + 1, end: segments[0].end, replacement: '' };
  if (k > 0 && segments[k - 1].kind === 'active') {
    return { start: segments[k - 1].end, end: segments[k].end, replacement: '' };
  }
  const commaPos = findSeparatorComma(text, segments[k].end, scanTo);
  const end = commaPos !== -1 ? commaPos + 1 : segments[k].end;
  const start = k === 0 ? arrayStart + 1 : segments[k - 1].end;
  return { start, end, replacement: '' };
}

// Build the zero-width edit that inserts a new stage before segment k (k may be
// segments.length, meaning append). A boundary comment stays with the FOLLOWING
// stage.
function insertEdit(segments: any[], k: number, stage: any, arrayStart: number) {
  const body = reindentStage(stage);
  // Anchor after the nearest ACTIVE stage before k (disabled blocks are comments
  // with no comma). Inserting `,<body>` there is always valid: the comma before
  // the new stage is the one we add; the comma after it is whatever already
  // separated the anchor from the next visible element (or a now-trailing comma).
  let prevActiveEnd = -1;
  for (let j = k - 1; j >= 0; j--) {
    if (segments[j].kind === 'active') {
      prevActiveEnd = segments[j].end;
      break;
    }
  }
  if (prevActiveEnd !== -1) {
    return { start: prevActiveEnd, end: prevActiveEnd, replacement: `,\n  ${body}` };
  }
  // No active stage precedes k: the new stage becomes the first visible element.
  const hasNextActive = segments.slice(k).some((s) => s.kind === 'active');
  const at = arrayStart + 1;
  return { start: at, end: at, replacement: `\n  ${body}${hasNextActive ? ',' : ''}` };
}

// Apply a pipelineOps mutator and write back as MINIMAL text edits: only the
// stage(s) the mutation actually changes are reserialized; every other byte
// (untouched stages, comments, formatting, disabled blocks) is preserved.
// Returns the new text, or null when the text can't be parsed.
export function applyMutationToText(text: string, mutator: (stages: any[]) => void): string | null {
  const { ok, segments, arrayStart, arrayEnd } = parsePipelineDoc(text);
  if (!ok) return null;

  // Empty pipeline: nothing to preserve — build canonically from the result.
  if (segments.length === 0) {
    const work0: any[] = [];
    mutator(work0);
    if (work0.length === 0) return text;
    return '[\n  ' + work0.map((s) => reindentStage(s)).join(',\n  ') + '\n]';
  }

  // Identity-stable work array: active stages BY REFERENCE (pipelineOps never
  // mutate a stage object in place, only reassign/splice slots, so untouched
  // stages keep their reference); disabled stages ride as inert placeholders.
  const origWork = segments.map((s) => (s.kind === 'active' ? s.stage : { [PLACEHOLDER]: true }));
  const work = origWork.slice();
  mutator(work);

  const origSet = new Set(origWork);
  const workSet = new Set(work);

  const edits = [];
  let oi = 0;
  let wi = 0;
  while (oi < segments.length || wi < work.length) {
    const o = oi < segments.length ? origWork[oi] : undefined;
    const w = wi < work.length ? work[wi] : undefined;
    if (o !== undefined && o === w) {
      oi += 1;
      wi += 1;
      continue;
    } // kept
    const oRemoved = o !== undefined && !workSet.has(o);
    const wNew = w !== undefined && !origSet.has(w);
    if (oRemoved && wNew) {
      // replace in place — splice only this span
      edits.push({
        start: segments[oi].start,
        end: segments[oi].end,
        replacement: reindentStage(w),
      });
      oi += 1;
      wi += 1;
    } else if (oRemoved) {
      edits.push(removeEdit(text, segments, oi, arrayStart, arrayEnd));
      oi += 1;
    } else if (wNew) {
      edits.push(insertEdit(segments, oi, w, arrayStart));
      wi += 1;
    } else {
      return null; // mutator reordered stages (pipelineOps never does) — refuse rather than corrupt
    }
  }
  return applyEdits(text, edits);
}

// Effective pipeline guard: all stages disabled -> JSON5.parse yields [] -> run
// all records instead of sending a bare []. Operates on already-substituted text.
export function normalizeEffectivePipelineText(substitutedText: string): string | null {
  try {
    const parsed = JSON5.parse(substitutedText);
    if (Array.isArray(parsed) && parsed.length === 0) return JSON.stringify([{ $match: {} }]);
  } catch {
    /* fall through — let the caller handle invalid text */
  }
  return substitutedText;
}

// Beautify: reserialize each stage's span canonically while leaving ALL gaps
// (commas, whitespace, standalone/leading/trailing comments) untouched. A
// comment INSIDE a stage is reflowed away with that stage. null on invalid text.
export function beautifyText(text: string): string | null {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok) return null;
  const edits = segments.map((seg) => {
    if (seg.kind === 'active') {
      return { start: seg.start, end: seg.end, replacement: reindentStage(seg.stage) };
    }
    const inner: string = seg.stage != null ? reindentStage(seg.stage) : seg.raw!;
    return {
      start: seg.start,
      end: seg.end,
      replacement: `/* ${SENTINEL}\n${inner.replace(/\*\//g, '*\\/')} */`,
    };
  });
  return applyEdits(text, edits);
}

// 1-based line spans for each top-level stage, for the editor gutter.
export function stageLineRanges(text: string): any[] {
  const { ok, segments } = parsePipelineDoc(text);
  if (!ok) return [];
  const lineAt = (off: number) => {
    let ln = 1;
    for (let k = 0; k < off && k < text.length; k++) if (text[k] === '\n') ln += 1;
    return ln;
  };
  return segments.map((s, idx) => ({
    entryIndex: idx,
    disabled: s.kind === 'disabled',
    start: s.start, // char offset of the stage's '{' (active) — may sit mid-line, e.g. "},{"
    end: s.end, // char offset just past the stage's closing '}'
    lineStart: lineAt(s.start),
    lineEnd: lineAt(s.end - 1),
  }));
}

// Which ENTRY index (0-based over ALL top-level stages, disabled included) the
// char `offset` falls in, or null when it's outside every stage. `ranges` is the
// output of stageLineRanges(). This is the index that addresses a Stages-view
// SECTION — the view renders one per entry, so a disabled stage has one too —
// and it is what links the editor's caret and pointer to that section.
//
// It had a companion, activeStageIndexAtOffset, answering the other question:
// which stage the aggregation actually EXECUTED, i.e. which stage OUTPUT to
// scroll to. Deleted 2026-08-14 with the editor-driven scroll it served (the
// text editor no longer moves the Stages pane), leaving one index space here.
export function entryIndexAtOffset(ranges: any[], offset: number): number | null {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return r.entryIndex;
  }
  return null;
}
