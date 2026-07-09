# "Annotate for me" — Design

- **Date:** 2026-07-07
- **Status:** Design (pre-implementation). All make-or-break facts verified live, including the box-write contract (2026-07-07, owner-authorized reversible test — see §3 fact 6).
- **Author:** brainstormed with the SA (owner) — all forks below were chosen by the owner.

## 1. Summary

A one-click, **in-page** feature on the Rossum validation/document screen that re-annotates
the open document with Mr. Fabry: it looks at the **page image (vision)** plus the **fullpage
OCR spatial data** and the current extracted fields, redraws/improves bounding boxes and
corrects values, **validates against master data (MDH) and native Rules**, and **loops until the
annotation is clean** — auto-applying changes with a full **undo** snapshot. A human still owns
final sign-off (the feature never confirms/exports/deletes).

Working feature name: **"Annotate for me"** (button label TBD; storage key `annotateForMeEnabled`).

## 2. Goals / Non-goals

**Goals**
- Correct poor backend annotations: both **field values** and **bounding-box geometry**, in one pipeline.
- Ground box corrections in real spatial data (OCR words + the page image), not guesses.
- Validate corrections against the queue's actual validation surface (MDH matching + native Rules + schema constraints) and iterate until no correctable errors remain.
- Stay fully reversible (snapshot + one-click undo) and off-by-default (backward-compatible).

**Non-goals (v1)**
- No auto-confirm / auto-export / auto-approve. The feature leaves the annotation in review.
- No training/feedback into the extraction engine.
- No batch/multi-annotation mode. One open annotation at a time.
- No new server-side component. Everything runs in the extension + the existing Rossum-hosted Fabry service.

## 3. Verified facts (grounded live before design — no assumptions)

Verified against the Rossum shared demo API and the deployed Agent API. No customer org, no customer data.

1. **Bounding boxes are first-class, readable data.** Each captured datapoint's `content` carries
   `position: [x1,y1,x2,y2]`, `page`, `rir_confidence`, plus **immutable source records**
   `rir_position` / `ocr_position` / `connector_position` and text sources (`ocr_text`, `rir_text`,
   `value`, `normalized_value`). The `position` vs `rir_position` split is strong structural evidence
   that `position` is the editable box (item ① in §10 confirms writability).
2. **Fullpage spatial data exists and is text-serializable.** `GET /annotations/{id}/page_data?granularity=words`
   (granularity is required) → `results: [{ page_number, granularity, items: [{ position:[x1,y1,x2,y2], text }] }]`.
3. **Field boxes and OCR word boxes share one coordinate space.** A header field's box overlapped
   exactly one OCR word box at nearly identical coordinates — so a model given words + field boxes in
   one frame can map words↔fields deterministically.
4. **Fabry CAN do vision.** The Agent API (`v2.2.0dev0` at `rossum-agent-api.tools.rossum.cloud`) accepts
   `POST /chats/{id}/messages` with body `{ "content": "<string>", "images": [{ "media_type": "image/png", "data": "<base64>" }] }`
   → HTTP 200, and the model genuinely perceives the image (confirmed with a synthetic image it described
   correctly). Notes:
   - `content` **must be a string** (an image-array in `content` → HTTP 422). Images go in the separate `images` field.
   - The `images` field is **not in the documented OpenAPI `MessageRequest`** (dev build) → **feature-detect and degrade** to text-only.
   - Fabry has **no tool** to fetch a Rossum page image or `page_data` itself (its `get` is entity-based, not an arbitrary-path HTTP client). So the **extension** must fetch and pass both.
5. **Vision cost is modest.** Page image endpoints: `/pages/{id}/content` (~150 KB PNG for a 1240×1605 page)
   and `/pages/{id}/preview` (~78 KB). Vision cost scales with dimensions (~2.6k tokens/page), not base64 length.
   Images are a **separate field** from the text `content`, so the ~48–50k-char text budget is spent independently.
6. **The write path is confirmed (owner-authorized reversible test, 2026-07-07).** `POST /annotations/{id}/content/operations`
   wrapped as start → operations → release. A `replace` op with `value: { content: { value, position, page } }`
   **writes the bounding box** (HTTP 200; read-back showed the moved box; restore returned it exactly). Confirmed details:
   - The op **returns the full updated content tree** in its response → no re-GET needed after apply.
   - After the edit, `validation_sources` becomes `["human"]`; **`position` holds the edit while `rir_position` stays the immutable AI original** — so read `position` for current, `rir_position` for provenance.
   - Setting `value` explicitly in the same op **prevents re-OCR from changing the value** when the box moves (mitigates risk ③).
   - `start` → `{annotation, session_timeout}` (~1h lock); `cancel` → 204, status → `to_review`.
7. **The validation oracle** is `POST /annotations/{id}/content/validate` (fires the hook chain incl. MDH
   matching + native Rules) → `messages` / blockers. "Validate against master data" = this call.
8. **Extension surface:** the Rossum content script is a MutationObserver over added subtrees, features gated
   by `chrome.storage.local` toggles; always-on features follow an idempotent-injection pattern. No spatial/
   overlay code exists today (greenfield). A floating "Inspect this annotation" button existed on the
   validation screen and was **removed 2026-07-04 by owner request** → v1 uses a **docked** button, not a floating one.
   Current annotation id is read from `/document/<id>` (the annotation id) via the `track-viewed` pattern.

## 4. Decisions (owner-chosen)

| Fork | Decision |
|---|---|
| Core scope | **Both** value + box geometry, as one pipeline |
| Write posture | **Auto-apply with undo** (snapshot original, apply, loop, show changelog + revert) |
| Placement | **Fully in-page** on the validation screen |
| Correction scope | **Whole document** — re-examine every field + box |
| Box precision | **Hybrid** — snap to exact OCR word boxes when words match; fall back to Fabry's pixel box for text-less regions |

## 5. Architecture

New content-script feature module `src/rossum/features/annotate-for-me.js` (init + handleNode for the
button) plus a small in-page pipeline/UI. Fabry access reuses `src/mdh/agent/agentApi.js` +
`agentStream.js`, extended for the `images` field. Proposed new files:

- `src/rossum/features/annotate-for-me.js` — feature entry: injects the docked button (idempotent, SPA-safe), owns the run lifecycle.
- `src/rossum/annotate/gather.js` — read-only fetch of content, page image(s), `page_data` words, schema, and the first `content/validate` result.
- `src/rossum/annotate/prompt.js` — pure: serialize fields + errors + scoped OCR words into the text prompt; select/prepare page image(s).
- `src/rossum/annotate/proposal.js` — pure: parse Fabry's structured proposal; **box resolution** (hybrid snap-to-OCR / pixel fallback); diff vs current content.
- `src/rossum/annotate/apply.js` — snapshot, build `content/operations`, apply, and the inverse (undo) operations.
- `src/rossum/annotate/loop.js` — orchestrate gather → reason → apply → validate → refine with the stop conditions.
- `src/rossum/annotate/ui.js` (or a small Preact panel) — progress + changelog + undo panel injected in-page.
- Extend `src/mdh/agent/agentApi.js`: `streamMessage(chatId, content, { images, onEvent, signal })` (additive; text-only callers unchanged → backward-compatible) + a cached **vision probe** (`visionAvailable(org)` → `sessionStorage: annotateVision_<org>`).

Wire-up mirrors existing features: add `annotateForMeEnabled` to `SETTINGS_KEYS` in `src/rossum/index.js`,
gate `init()`/`handleNode()`, add a popup checkbox.

## 6. Pipeline

**Gather (read-only, parallel)** — annotation content; `page_data?granularity=words`; page image(s) via
`/pages/{id}/preview` (smaller; fall back to `/content` if higher fidelity needed), base64; schema; first
`content/validate` → messages/blockers.

**Reason (Fabry, vision)** — fresh chat, `/persona cautious`. Message:
- `content` (text): task framing + per-field list (`schema_id`, current value, current box, `rir_confidence`,
  threshold) + active validation errors + schema constraints + **scoped** OCR words (near each field / per page,
  to respect the text budget — the image carries global layout).
- `images`: the page image(s) (feature-detected; if unsupported, include a fuller OCR-word serialization instead).
- Response: a **structured JSON proposal** — for each field to change: `schema_id`, `new_value`,
  `box_words` (the OCR text/tokens the field maps to) **or** `box_pixels` `[x1,y1,x2,y2]`, `reason`, `confidence`.
  Emit **only changes**; leave already-correct high-confidence fields untouched (regression guard).

**Resolve boxes (pure, hybrid)** — for each proposed field: if `box_words` match OCR words, compute the box as
their coordinate union (deterministic pixel precision); else use `box_pixels`. Validate boxes lie within page bounds.

**Apply (auto + snapshot)** — snapshot ALL datapoints (`{id, value, position, page}`) → `annotateSnapshot`
(in-memory + optionally `sessionStorage` for reload-survival). Apply changes via `content/operations`
(start → replace ops with `content: {value, position, page}` → release). Never confirm/export/delete.

**Validate & loop** — `content/validate` → messages/blockers. If correctable errors remain **and** the error
set is strictly shrinking, feed the new state + remaining errors into the **same** Fabry chat → re-resolve →
re-apply → re-validate. **Stop** on: (a) no error-level messages (success), (b) no-progress (error set didn't
shrink), or (c) hard cap **3 iterations**. On give-up: keep best-effort, report unresolved errors.

**Result UI + refresh** — in-page panel: per-field changelog (old→new value, old→new box, why, source badge
vision/OCR/MDH), remaining unresolved errors, **"Undo all"** (replays snapshot as inverse operations) + per-field
undo. Then refresh the document view so boxes reflect changes.

## 7. Safety, backward-compat, no-leak

- **Off by default.** New toggle; zero overhead when disabled (matches existing feature pattern). Existing users unaffected.
- **Explicit action only.** Nothing runs until the user clicks. Auto-apply is scoped to the one open annotation.
- **Reversible.** Full snapshot + one-click undo; never signs off; hard iteration cap; never deletes rows/fields (v1 replaces values/boxes only — table row add/remove is a later phase).
- **Feature-detect vision.** Degrades to text-only (OCR-word serialization) if a Fabry deployment rejects `images`. Text-only callers of `streamMessage` are unchanged (additive API).
- **No data leak.** All data stays within the user's Rossum session + the Rossum-hosted Fabry service — the **same trust boundary the extension already uses** for Fabry today. No third parties. No customer names/values in logs or telemetry; the in-page UI shows the user's own document data only.

## 8. Testing strategy

- **Pure units (vitest):** `prompt.js` serialization + budget scoping; `proposal.js` parse + **hybrid box resolution** (snap union, pixel fallback, page-bounds clamp) + diff; `apply.js` operation build + inverse/undo; `loop.js` stop conditions (clean / no-progress / cap) with mocked gather+Fabry.
- **Vision probe:** cached-probe logic (200 vs 422 → vision on/off) with a mocked transport.
- **No live-API tests** in CI; the make-or-break live checks are the §10 items, run manually against a test org.
- Follow repo conventions: `.test.js` using `h()` + `vi.mock`, condition-based `waitFor` (no fixed timeouts).

## 9. Rollout

1. Resolve §10 item ① (box-write contract) — gates the geometry half.
2. Build gather + prompt + proposal + hybrid resolution + **dry-run** (proposal only, no writes) behind the toggle; dogfood the proposals.
3. Add apply + undo + loop; dogfood auto-apply on test annotations.
4. Rebuild `dist/` and dogfood in-browser (tests run against `src/`, the loaded extension runs `dist/` — `npm run build`, reload the extension, reload the Rossum tab so the content script re-injects).

## 10. Open risks — verify BEFORE building (not assumptions)

1. **① Box-write contract — ✅ RESOLVED (verified 2026-07-07, owner-authorized).** `content/operations` `replace`
   with `content: {value, position, page}` writes and persists the box; reversible restore confirmed. See §3 fact 6.
   No longer a blocker; geometry half is feasible.
2. **② SPA concurrency (sharpest risk of the in-page choice).** Writing while the user has the annotation open
   holds a review lock and risks clobbering unsaved manual edits; the SPA won't reflect API writes until reload.
   Verify: does `start` conflict when the user's session already holds `reviewing`? Mitigation plan: run only on
   a freshly-opened/unedited annotation or confirm-before-run; reload after apply; document that in-flight
   unsaved manual edits are not preserved.
3. **③ Re-OCR on box change.** Setting a new box may cause the server to re-extract the region's text. Decide
   whether to trust Fabry's `new_value` (set explicitly in the same op) or the re-extracted value. Default:
   set value explicitly so the box move can't silently change the value.
4. **④ Size caps on long/dense docs.** Multi-page image payloads and OCR-word text can grow large. Plan:
   preview-resolution images, page capping/downscaling, and field-scoped OCR serialization; `log()` anything dropped.
5. **⑤ `images` field stability.** Dev build (`v2.2.0dev0`); undocumented field. Feature-detect via cached probe; degrade gracefully.
