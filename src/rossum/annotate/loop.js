// src/rossum/annotate/loop.js — auto-annotate write loop, GEOMETRY-FIRST.
//
// Phase 1 (deterministic, seconds): tighten every loose box to its OCR words and
// apply immediately — the user gets visible improvement even if the AI step never
// completes. Phase 2 (AI): Fabry proposes values / fills empty fields / adds
// missing rows off the page image; its boxes are snapped to OCR client-side; a
// hard guard drops any box that would overlap another. Validate + refine after.
// The annotation lock is NEVER held across a (slow) Fabry streaming turn's
// initial proposal, and every start is released in a finally.
import { gatherAnnotation, flattenFields, multivalueRowIds } from './gather.js';
import { readDocument } from './propose.js';
import { reconcileReading } from './reconcile.js';
import { buildFixPrompt } from './prompt.js';
import { parseProposal, resolveBoxes, diffProposals } from './proposal.js';
import { snapshotFields, buildReplaceOperations, buildAddOperations } from './apply.js';
import { saveSnapshot, loadSnapshot } from './undo.js';
import { startAnnotation, applyContentOperations, validateContent, parseValidateMessages, cancelAnnotation } from './annotationWrite.js';
import { tightenFields, destackFields, orphanClears, shrinkEngulfingBoxes, reseedFromRir, reseedTableByValues, repairMismatchedBoxes, findValueBox, boxMatchesValue, boxSquatsOnOthers, tightenBox, boxesOverlap } from './geometry.js';
import { remapEmptyColumns, linkGridRows, extendGridRows, deriveCellBoxes, buildGridOp } from './grid.js';
import { newAcc, foldEvents, replyText, toolLabel } from '../../mdh/agent/agentStream.js';

const MAX_CORRECTIONS = 3;
const errorSig = (errs) => errs.map((e) => `${e.datapointId ?? e.schemaId}:${e.content}`).sort().join('|');
const activity = (ev) => (ev.type === 'reasoning-start' ? 'analyzing the page…'
  : ev.type === 'tool-input-start' ? toolLabel(ev.toolName)
  : ev.type === 'text-delta' ? 'drafting corrections…' : null);

// Snap Fabry's rough pixel boxes to the OCR words they cover ('ocr'-sourced boxes
// are already exact word unions). Then enforce the hard no-overlap-on-write
// invariant. Conflict resolution, in order:
//  1. the conflicting box belongs to an EMPTY-valued field with no pending change
//     → auto-clear that orphaned box (verified live: position:null removes it) and keep ours;
//  2. otherwise → drop our box move (the value change, if any, is kept).
// Clear-box changes always keep (they free space, never take it), and are ordered
// FIRST so the ops batch releases squatted text before boxes move onto it.
function snapAndGuard(changes, fields, ocrPages) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const fieldBy = Object.fromEntries(fields.map((f) => [f.datapointId, f]));
  const snapped = changes.map((c) => {
    let out = c;
    if (c.boxChanged && c.newBox && c.boxSource === 'pixels') {
      const t = tightenBox(c.newBox, wordsByPage[c.page] || [], 1);
      if (t !== c.newBox) out = { ...c, newBox: t };
    }
    // THE box invariant: a box must contain its value's text. A box that doesn't
    // (wrong occurrence, wrong region) is re-located to the value's real position,
    // or dropped — a wrong box is worse than none.
    if (out.boxChanged && out.newBox && !out.clearBox
        && (out.boxSource === 'ocr' || out.boxSource === 'pixels')
        && !boxMatchesValue(out.newValue ?? out.oldValue, out.newBox, wordsByPage[out.page] || [])) {
      const f = fieldBy[out.datapointId];
      const found = f ? findValueBox({ ...f, value: out.newValue ?? f.value, position: null },
        fields.filter((g) => g.datapointId !== out.datapointId), wordsByPage) : null;
      if (found) out = { ...out, newBox: found.box, page: found.page };
      else if (out.valueChanged) out = { ...out, newBox: out.oldBox, boxChanged: false };
      else out = null; // box-only change with unverifiable box → drop entirely
    }
    return out;
  }).filter(Boolean);
  const pending = new Set(snapped.map((c) => c.datapointId));
  const finalBox = new Map(fields.filter((f) => Array.isArray(f.position)).map((f) => [f.datapointId, f.position]));
  for (const c of snapped) {
    if (c.clearBox) finalBox.delete(c.datapointId);
    else if (c.boxChanged && c.newBox) finalBox.set(c.datapointId, c.newBox);
  }
  const clears = snapped.filter((c) => c.clearBox);
  const kept = [];
  for (const c of snapped) {
    if (c.clearBox) continue; // collected separately, emitted first
    if (c.boxChanged && c.newBox) {
      let clash = null;
      for (const [id, b] of finalBox) { if (id !== c.datapointId && b && c.page === (fieldBy[id] || {}).page && boxesOverlap(c.newBox, b)) { clash = id; break; } }
      if (clash != null) {
        const other = fieldBy[clash];
        const unmoved = other && !pending.has(clash);
        const otherEmpty = unmoved && String(other.value ?? '') === '';
        // Resolution ladder — make room deterministically before giving up:
        //  1. the blocker is an EMPTY-valued field → clear its orphaned box;
        //  2. the blocker's box TIGHTENS away from the conflict (it was just loose,
        //     e.g. a neighbor's box bleeding 1px into the next text line) → force-
        //     tighten it (bypasses the usual minSlack churn gate — conflict-driven);
        //  3. the blocker's box provably sits on OTHER fields' text (its own value
        //     is not inside it, ≥2 inside words are other fields' values) → clear
        //     the wrong box, keep the value;
        //  4. otherwise → drop OUR box move (never write an overlap).
        let resolved = false;
        if (otherEmpty) {
          clears.push({
            datapointId: other.datapointId, schemaId: other.schemaId, rowIndex: other.rowIndex ?? null,
            oldValue: other.value ?? null, newValue: other.value ?? '', oldBox: other.position, newBox: null,
            page: other.page, boxSource: 'cleared', reason: 'orphaned box removed to make room', confidence: null,
            valueChanged: false, boxChanged: true, clearBox: true,
          });
          pending.add(clash);
          finalBox.delete(clash);
          resolved = true;
        } else if (unmoved) {
          const t = tightenBox(other.position, wordsByPage[other.page] || [], 1);
          if (t !== other.position && !boxesOverlap(c.newBox, t)) {
            kept.push({
              datapointId: other.datapointId, schemaId: other.schemaId, rowIndex: other.rowIndex ?? null,
              oldValue: other.value ?? null, newValue: other.value ?? null, oldBox: other.position, newBox: t,
              page: other.page, boxSource: 'tighten', reason: 'tightened to make room', confidence: null,
              valueChanged: false, boxChanged: true,
            });
            pending.add(clash);
            finalBox.set(clash, t);
            resolved = true;
          } else if (boxSquatsOnOthers(other, fields, wordsByPage[other.page] || [])) {
            clears.push({
              datapointId: other.datapointId, schemaId: other.schemaId, rowIndex: other.rowIndex ?? null,
              oldValue: other.value ?? null, newValue: other.value ?? null, oldBox: other.position, newBox: null,
              page: other.page, boxSource: 'cleared', reason: 'wrong box removed (sat on other fields’ text)', confidence: null,
              valueChanged: false, boxChanged: true, clearBox: true,
            });
            pending.add(clash);
            finalBox.delete(clash);
            resolved = true;
          }
        }
        if (!resolved) {
          finalBox.set(c.datapointId, c.oldBox);
          if (c.valueChanged) kept.push({ ...c, newBox: c.oldBox, boxChanged: false });
          continue;
        }
      }
    }
    kept.push(c);
  }
  // Dedupe clears (orphan sweep + guard may both target the same field).
  const uniqClears = [...new Map(clears.map((c) => [c.datapointId, c])).values()];
  return [...uniqClears, ...kept];
}

// Repair every grid-backed table: remap mis-assigned empty columns, link rows to
// tuples, grow the grid to cover added rows — then derive per-cell boxes FROM the
// repaired grid (disjoint by construction). Returns { gridOps, cellChanges,
// originals } (originals keyed by mvId, for Undo).
function gridPass(gathered) {
  const gridOps = [];
  const cellChanges = [];
  const originals = {};
  for (const gi of gathered.grids || []) {
    let g = gi.grid;
    let changed = false;
    for (const fn of [
      (x) => remapEmptyColumns(x, gathered.fields),
      (x) => linkGridRows(x),
      (x) => extendGridRows(x, gathered.ocrPages),
    ]) {
      const r = fn({ ...gi, grid: g });
      if (r) { g = r; changed = true; }
    }
    // Grid WRITES are disabled: a replace op with {grid} returns 200 but the server
    // normalizes/ignores modified grids (and can even empty a part) — verified live
    // 2026-07-08. Cell boxes are derived only from grids that are already usable
    // (rows linked to tuples); repairing the grid itself needs the dedicated
    // grid_operations endpoint (future work).
    void changed; void buildGridOp; void originals;
    const usable = g.parts.every((part) => (part.rows || []).every((r) => r.tuple_id != null));
    if (usable) cellChanges.push(...deriveCellBoxes(gi, g, gathered.fields, gathered.ocrPages, tightenBox));
  }
  return { gridOps, cellChanges, originals };
}

// Deterministic geometry changes: orphaned-box clears, de-stacked row cells (only
// for tables WITHOUT a grid — grid tables get their boxes derived from the grid),
// grid-derived cell boxes, and tighten-to-OCR — all in the shared change shape.
function geometryChanges(gathered, grid) {
  const fieldBy = Object.fromEntries(gathered.fields.map((f) => [f.datapointId, f]));
  // A grid only GOVERNS a table when its rows are linked to tuples; an unlinked
  // grid is inert (the UI falls back to per-cell boxes), so per-cell de-stack and
  // tightening must still apply there.
  const gridTables = new Set((gathered.grids || [])
    .filter((g) => g.grid.parts.every((part) => (part.rows || []).every((r) => r.tuple_id != null)))
    .map((g) => g.schemaId));
  const nonGridFields = gathered.fields.filter((f) => !f.inLineItem || !gridTables.has(f.mvSchemaId));
  const enrich = (t, source, reason) => {
    const f = fieldBy[t.datapointId];
    return {
      datapointId: t.datapointId, schemaId: f.schemaId, rowIndex: f.rowIndex ?? null,
      oldValue: f.value ?? null, newValue: f.value ?? null, oldBox: t.oldBox, newBox: t.newBox,
      page: t.page, boxSource: source, reason, confidence: null,
      valueChanged: false, boxChanged: true,
    };
  };
  const derived = grid.cellChanges.map((t) => enrich(t, 'grid', 'aligned to the table grid'));
  const derivedIds = new Set(derived.map((c) => c.datapointId));
  const destacks = destackFields({ fields: nonGridFields, ocrPages: gathered.ocrPages })
    .filter((t) => !derivedIds.has(t.datapointId))
    .map((t) => enrich(t, 'row-align', 'moved to its own row'));
  const reseeds = [
    ...reseedFromRir({ fields: nonGridFields, ocrPages: gathered.ocrPages }),
    ...reseedTableByValues({ fields: nonGridFields, ocrPages: gathered.ocrPages }),
  ]
    .filter((t) => !derivedIds.has(t.datapointId) && !destacks.some((c) => c.datapointId === t.datapointId))
    .map((t) => enrich(t, 'row-align', 'box recovered from extraction evidence'));
  const reseedIds = new Set(reseeds.map((c) => c.datapointId));
  // Repair pass: existing boxes that don't contain their value's text get
  // relocated to the value (or cleared) — self-healing for wrong boxes from any
  // source (backend, earlier runs, the AI).
  const repairs = repairMismatchedBoxes({ fields: nonGridFields, ocrPages: gathered.ocrPages })
    .filter((t) => !derivedIds.has(t.datapointId) && !reseedIds.has(t.datapointId) && !destacks.some((c) => c.datapointId === t.datapointId))
    .map((t) => enrich(t, 'row-align', 'box moved to its value'));
  // Value-anchored reseeds outrank the engulf remainder heuristic: an engulf box
  // landing on a reseed's words is itself squatting — drop it so the guard's
  // squatter-clear can resolve the underlying wrong box instead.
  const engulfs = shrinkEngulfingBoxes({ fields: nonGridFields, ocrPages: gathered.ocrPages })
    .filter((t) => !derivedIds.has(t.datapointId) && !destacks.some((c) => c.datapointId === t.datapointId))
    .filter((t) => !reseeds.some((r) => r.newBox && boxesOverlap(t.newBox, r.newBox)))
    .map((t) => enrich(t, 'row-align', 'shrunk to its own line'));
  const skip = new Set([...derivedIds, ...destacks.map((c) => c.datapointId), ...reseeds.map((c) => c.datapointId), ...engulfs.map((c) => c.datapointId)]);
  const tights = tightenFields({ fields: nonGridFields, ocrPages: gathered.ocrPages })
    .filter((t) => !skip.has(t.datapointId))
    // A box overlapping a value-anchored reseed is presumptively WRONG — don't
    // legitimize it by tightening; leave it to the guard's resolution ladder.
    .filter((t) => !reseeds.some((r) => r.newBox && t.oldBox && boxesOverlap(t.oldBox, r.newBox)))
    .map((t) => enrich(t, 'tighten', 'tightened to text'));
  return [...orphanClears({ fields: gathered.fields }), ...derived, ...destacks, ...reseeds, ...repairs, ...engulfs, ...tights];
}

// Composite annotation-quality score driving the outer improvement loop:
// +1 per valued field with a box, −2 per overlapping box pair, −2 per error.
function qualityScore(fields, errorsCount, ocrPages) {
  const wordsByPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p.words || []]));
  const valued = fields.filter((f) => String(f.value ?? '') !== '');
  const boxedValued = valued.filter((f) => Array.isArray(f.position)).length;
  const mismatched = valued.filter((f) => Array.isArray(f.position)
    && !boxMatchesValue(f.value, f.position, wordsByPage[f.page] || [])).length;
  const boxed = fields.filter((f) => Array.isArray(f.position));
  let overlaps = 0;
  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length; j++) {
      if (boxed[i].page === boxed[j].page && boxesOverlap(boxed[i].position, boxed[j].position)) overlaps++;
    }
  }
  // A captured value counts even before it has a box (freshly added rows must move
  // the score); a box that doesn't contain its value counts AGAINST.
  return valued.length + boxedValued - 2 * mismatched - 2 * overlaps - 2 * errorsCount;
}

const MAX_PASSES = 3;

export async function runAnnotate({ annotationId, token, domain, deps, onProgress = () => {}, onPartial = () => {} }) {
  const { getJson, getBase64, streamFabry, post, store } = deps;

  // Merge-preserve any prior snapshot (a retry after a partial run) — prior values
  // are the true originals and must never be clobbered by post-write state.
  const prior = loadSnapshot(annotationId, store) || {};
  const touched = new Set();
  let snapshot = { ...prior };

  const applied = [];
  let remaining = [];
  let addedRows = 0;
  let note = null;
  // ONE Fabry reading per run (pass 1): the reading describes the PAGE, which
  // writes never change — later passes re-reconcile the cached reading against
  // the fresh annotation state (e.g. rows added in pass 1 get boxes in pass 2).
  let readingCtx = null;
  // Values set by validation-driven refine turns outrank the raw reading —
  // reconcile must never write them back (page prints ≠ master data accepts).
  const refinedIds = new Set();
  let prevScore = null;

  // ---- Outer improvement loop: keep passing while the quality score improves,
  // stop on plateau (or the safety cap). Later passes benefit from earlier ones —
  // e.g. newly boxed cells create the row bands that let the NEXT pass recover
  // their table neighbours.
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    onProgress('gather', pass === 1 ? 'Reading the document…' : `Re-reading (pass ${pass})…`);
    const gathered = await gatherAnnotation(annotationId, { getJson, getBase64 });
    const extendSnapshot = (ids) => {
      const fresh = ids.filter((id) => !touched.has(id));
      if (!fresh.length) return;
      fresh.forEach((id) => touched.add(id));
      // Originals for ids first touched in pass N = their state at pass-N start
      // (untouched before → identical to the true pre-run state).
      snapshot = { ...snapshotFields(gathered.fields, fresh), ...snapshot };
      saveSnapshot(annotationId, snapshot, store);
    };
    if (prevScore == null) prevScore = qualityScore(gathered.fields, gathered.messages.filter((m) => m.type === 'error').length, gathered.ocrPages);

    let fields = gathered.fields;
    let content = gathered.contentTree;
    let passApplied = 0;

  // ---- Phase 1: deterministic geometry (instant; independent of the AI) ----
  onProgress('geometry', 'Repairing table grid and tightening boxes…');
  const grid = gridPass(gathered);
  const tighten = snapAndGuard(geometryChanges(gathered, grid), gathered.fields, gathered.ocrPages);
  if (tighten.length || grid.gridOps.length) {
    extendSnapshot(tighten.map((c) => c.datapointId));
    if (Object.keys(grid.originals).length) {
      snapshot = { ...snapshot, __grids: { ...(snapshot.__grids || {}), ...grid.originals } };
      saveSnapshot(annotationId, snapshot, store);
    }
    await startAnnotation(annotationId, { post });
    try {
      // Grid repairs go FIRST so derived cell boxes land on a consistent grid.
      content = await applyContentOperations(annotationId, [...grid.gridOps, ...buildReplaceOperations(tighten)], { post });
    } finally {
      await cancelAnnotation(annotationId, { post });
    }
    applied.push(...tighten);
    passApplied += tighten.length;
    fields = flattenFields(content);
    onProgress('geometry', `${tighten.length} box${tighten.length === 1 ? '' : 'es'} fixed${grid.gridOps.length ? ' · table grid repaired' : ''}`);
    // Geometry results are final the moment they're written — surface them NOW so
    // the UI shows them while the (much slower) AI stage is still running.
    onPartial({ applied: applied.slice(), addedRows });
  }

  // ---- Phase 2: Fabry READS the document ONCE (pass 1, lock NOT held during
  // the turn) — values + verbatim printed quotes, zero geometry. Every pass
  // then RECONCILES the cached reading against the fresh annotation state and
  // LOCATES quotes in the client's own OCR (whole-table sequence alignment for
  // cells, line-coherent matching for headers). Later passes cost seconds.
  if (pass === 1) {
    try {
      onProgress('propose', 'Mr. Fabry is analyzing…');
      readingCtx = await readDocument({
        gathered, token, domain, streamFabry,
        onEvent: (ev) => { const a = activity(ev); if (a) onProgress('propose', a); },
      });
      if (!readingCtx.reading) note = 'Mr. Fabry’s reading could not be parsed — deterministic fixes were still applied.';
    } catch (e) {
      if (!applied.length) throw e; // nothing applied yet → surface the failure as before
      note = 'AI analysis failed or timed out — deterministic box tightening was still applied.';
    }
  }

  if (readingCtx && readingCtx.reading) {
    const rec = reconcileReading(readingCtx.reading, { fields, ocrPages: gathered.ocrPages, schemaFields: gathered.schemaFields, skipValueIds: refinedIds });
    const fabryChanges = snapAndGuard(rec.changes, fields, gathered.ocrPages);
    const addRows = rec.addRows.filter((r) => gathered.multivalues[r.table] != null);
    const addOps = buildAddOperations(addRows, gathered.multivalues);

    if (fabryChanges.length || addOps.length) {
      passApplied += fabryChanges.length + addOps.length;
      extendSnapshot(fabryChanges.map((c) => c.datapointId));
      await startAnnotation(annotationId, { post });
      try {
        if (fabryChanges.length) {
          onProgress('apply', `Applying ${fabryChanges.length} correction${fabryChanges.length === 1 ? '' : 's'}…`);
          content = await applyContentOperations(annotationId, buildReplaceOperations(fabryChanges), { post });
          applied.push(...fabryChanges);
          fields = flattenFields(content);
        }
        if (addOps.length) {
          const tablesTouched = [...new Set(addRows.map((r) => r.table))];
          const before = {};
          for (const t of tablesTouched) before[t] = multivalueRowIds(content, t);
          onProgress('apply', `Adding ${addOps.length} table row${addOps.length === 1 ? '' : 's'}…`);
          content = await applyContentOperations(annotationId, addOps, { post });
          const newIds = [];
          for (const t of tablesTouched) {
            const after = multivalueRowIds(content, t);
            for (const id of after) if (!before[t].includes(id)) newIds.push(id);
          }
          addedRows += newIds.length;
          if (newIds.length) {
            snapshot = { ...snapshot, __addedRows: [...(snapshot.__addedRows || []), ...newIds] };
            saveSnapshot(annotationId, snapshot, store);
          }
          fields = flattenFields(content);
        }

        onProgress('validate', 'Checking against master data…');
        remaining = parseValidateMessages(await validateContent(annotationId, { post })).filter((m) => m.type === 'error');

        let prevSig = null;
        for (let i = 0; i < MAX_CORRECTIONS && remaining.length; i++) {
          const sig = errorSig(remaining);
          if (sig === prevSig) break; // no progress
          prevSig = sig;
          onProgress('refine', `Fixing ${remaining.length} issue${remaining.length === 1 ? '' : 's'} — attempt ${i + 1}/${MAX_CORRECTIONS}…`);
          const acc = newAcc();
          try {
            await streamFabry({ token, domain, chatId: readingCtx.chatId, content: buildFixPrompt({ errors: remaining, fields, schemaFields: gathered.schemaFields }),
              onEvent: (ev) => { foldEvents(acc, [ev]); const a = activity(ev); if (a) onProgress('refine', a); } });
          } catch {
            note = 'AI refinement failed or timed out — earlier corrections were kept.';
            break;
          }
          const fix = snapAndGuard(diffProposals(resolveBoxes(parseProposal(replyText(acc)), gathered.ocrPages, fields), fields), fields, gathered.ocrPages);
          if (!fix.length) break; // agent produced nothing actionable
          passApplied += fix.length;
          fix.forEach((c) => { if (c.valueChanged) refinedIds.add(c.datapointId); });
          extendSnapshot(fix.map((c) => c.datapointId));
          content = await applyContentOperations(annotationId, buildReplaceOperations(fix), { post });
          applied.push(...fix);
          fields = flattenFields(content);
          remaining = parseValidateMessages(await validateContent(annotationId, { post })).filter((m) => m.type === 'error');
        }
      } finally {
        await cancelAnnotation(annotationId, { post });
      }
    }
  }

    // ---- Plateau detection: continue while the quality score improves. ----
    const score = qualityScore(fields, remaining.length, gathered.ocrPages);
    onProgress('pass', `Pass ${pass}: quality ${score}${prevScore != null ? ` (was ${prevScore})` : ''}`);
    if (passApplied === 0 || score <= prevScore) break; // plateaued (or nothing changed)
    prevScore = score;
  }

  // Transparency: valued fields the pipeline could NOT box — either their value
  // is not printed on the page (derived/classified values) or every printed
  // occurrence is already claimed by another field (boxing it would overlap).
  let unboxed = [];
  try {
    const finalGathered = await gatherAnnotation(annotationId, { getJson, getBase64 });
    unboxed = finalGathered.fields
      .filter((f) => String(f.value ?? '') !== '' && !Array.isArray(f.position))
      .map((f) => ({ schemaId: f.schemaId, rowIndex: f.rowIndex ?? null }));
  } catch { /* reporting only — never fail the run over it */ }

  if (!applied.length && !addedRows) {
    onProgress('done', 'No changes needed');
    return { applied: [], remaining, addedRows: 0, undoable: false, note, unboxed };
  }
  const addedNote = addedRows ? ` · ${addedRows} row${addedRows === 1 ? '' : 's'} added` : '';
  onProgress('done', `Applied ${applied.length}${addedNote} · ${remaining.length} unresolved`);
  return { applied, remaining, addedRows, undoable: true, note, unboxed };
}
