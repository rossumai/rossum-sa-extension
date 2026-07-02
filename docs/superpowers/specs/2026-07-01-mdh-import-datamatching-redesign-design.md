# MDH Import Redesign — Data-Matching API + Shape Validation — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** Dataset Management (MDH) Console app — `src/mdh/`
**Builds on:** the unified dataset import (uncommitted on master). This redesign **repurposes** that work: it keeps Insert on Data Storage, but moves Update/Replace onto the MDH data-matching API and adds shape validation.

## 1. Problem & goal

The current import conflated per-record semantics (Insert / per-record Update / per-record Replace + upsert), all hand-rolled on the Data Storage API with a client-side match engine (probe → resolve each row to one `_id` → per-row `update_one`/`replace_one` pool). The owner redefined the operations:

- **Insert** — add new documents.
- **Update** — one operation that updates existing records (full per-record overwrite) and inserts the ones that don't exist (an **upsert**), matched by chosen key(s).
- **Replace** — replace the **entire collection** with the file's contents.
- **Shape validation** (new) — by default validate incoming data against the existing records' shape and only allow the import when it matches; toggle to disable.

Rossum's **MDH data-matching API** already performs upsert-by-key and whole-dataset replace server-side, correctly and atomically. Goal: route Update/Replace through it, keep Insert on Data Storage (the data-matching API has no append-to-existing primitive), add a client-side shape guard, and retire the now-unnecessary client-side match engine.

### Non-goals
- No `_id` round-tripping through MDH (server-assigned — inherent, accepted).
- No client-side "matched/new/skipped" preview for Update/Replace (server does matching async — accepted).
- No deep per-array-element shape analysis (arrays are a leaf type).
- No change to the Insert (Data Storage) execution path.

## 2. Verified facts (live-probed 2026-07-01 on `@mrtnzlml (sandbox)`, elis.rossum.ai)

Full contract recorded in memory `reference_mdh_datamatching_dataset_api`. Key points:

- **Service**: `{appDomain}/svc/data-matching/api/v1` (distinct from `svc/data-storage`). OpenAPI at `{appDomain}/svc/data-matching/openapi.json`.
- **Datasets == the Data Storage collections this app lists** (both listings matched by name). So this operates on the real collections. (Minor asymmetry: data-matching may also list an `imported-<uuid>` / a `failed` dataset that is not a DS collection — an orphan/failed-import artifact.)
- **Endpoints**: `POST /dataset/{name}` create (create-ONLY → `400 "collection already exists"` on an existing name) · `PUT /dataset/{name}` replace whole dataset · `PATCH /dataset/{name}` update/upsert · `DELETE /dataset/{name}` · `GET /dataset/` list · `GET /operation/{id}` · `GET /operation/`.
- **All writes = `multipart/form-data`**: `file`*, `encoding`* (`utf-8`), `dynamic` (bool, default true), CSV opts. **PATCH also requires `id_keys`** (array — repeat the form field per key) + `update_or_new` (bool). **PUT** also has `replace_or_new`.
- **Async**: `202` + `Location: {appDomain}/svc/master-data-hub/api/v1/operation/{id}` (the data-matching alias `GET /operation/{id}` also works). **Latency is real (~30–60s even for tiny files).**
- **Operation** (`DatasetOperationOut`): `operation_type, operation_id, dataset_name, status, status_ts, create_ts, file_metadata{...}, error`. **Status is lowercase**: `processing|finished|failed|unknown|new|queued` (Data Storage uses UPPERCASE — needs its own poller).
- **Type fidelity**: upload **as JSON** preserves types (number/bool/nested object); **CSV stores everything as strings**. We already parse all 5 input formats into JS objects → serialize to JSON for upload.
- **`_id`**: server-assigned `{$oid}` per record; cannot be set/round-tripped. Matched (updated) records **keep** their `_id`; inserted rows get new ones. MDH also injects a `__digest_md5` field + `__digest_md5_idx`/`__dynamic_index`.
- **PATCH update semantics (verified)**: **full per-record overwrite** of matched (omitted fields dropped) **+ insert unmatched** when `update_or_new=true`. == the owner's Update definition.
- **PUT replace (verified)**: whole-dataset wipe+reload; **preserves custom indexes** (a created index survived).

## 3. Decisions (from brainstorming)

| # | Decision |
|---|---|
| Routing | **Hybrid.** Insert → Data Storage `insert_many` (unchanged blind append, dupes allowed, `_id`/types preserved). Update → MDH `PATCH` + `id_keys` + `update_or_new=true`. Replace → MDH `PUT`. |
| Upload format | Serialize parsed rows to **JSON**; upload as a JSON file (`encoding=utf-8`). All input formats (JSON/JSONL/CSV/XLSX/XML) parse → JS objects → JSON. |
| Update = upsert | `update_or_new=true` always (owner: "always insert unmatched", no toggle). Full per-record overwrite of matched. |
| Async | New data-matching poller; lowercase statuses; op id from `Location`. |
| Trade-offs | Server-assigned `_id` (no round-trip), ~30–60s latency, injected `__digest_md5` — all accepted. |
| Shape = | Deep (nested) field **names + types**, exact-set match. |
| Shape strictness | **Exact same field set**: each incoming doc's deep path set must equal the reference set; types must agree; no missing, no extra. |
| Shape scope | **All three modes** (Insert, Update, Replace). |
| Non-uniform data | If the existing collection isn't uniform (a path missing from some records, or multiple types on a path), **warn** ("existing data isn't uniform; validation may over-reject") and **suggest disabling** validation. Do NOT auto-relax or silently block. |
| Toggle | Shape validation default **ON**; a checkbox disables it per import (persisted globally, `mdhImportValidateShape`). When off → skipped entirely. Empty/new collection → skipped. |
| Commit policy | Write this spec; **do not git-commit** (standing owner preference). |

## 4. Architecture / files

The importer becomes a **router** over two backends.

- **`src/mdh/api.js`** — add data-matching client + poller:
  - `datasetReplace(name, file /*Blob*/)` → `PUT …/svc/data-matching/api/v1/dataset/{name}` multipart (`file`, `encoding='utf-8'`). Returns `{ operationId }` parsed from `Location`.
  - `datasetUpdate(name, file, idKeys /*string[]*/)` → `PATCH …/dataset/{name}` multipart (`file`, `encoding`, repeated `id_keys`, `update_or_new='true'`). Returns `{ operationId }`.
  - `waitForDatasetOperation(operationId, { signal, intervalMs, timeoutMs })` → polls `GET …/svc/data-matching/api/v1/operation/{operationId}`; resolves on `finished`, throws on `failed` (surfacing `error`), treats `unknown` as terminal-uncertain; tolerant of transient poll errors (mirror the existing `waitForOperation` resilience but for **lowercase** statuses). Keep the existing Data-Storage `waitForOperation` as-is.
  - (`Location` value is under `…/svc/master-data-hub/api/v1/operation/{id}`; poll via the data-matching alias for base consistency. Parse the id as the last path segment.)
- **`src/mdh/shape.js`** — NEW, pure (DOM-free, unit-tested):
  - `deriveShape(docs)` → `{ paths: Map<pathString, Set<typeString>>, uniform: boolean, optionalPaths: string[] }`. Walks each doc to deep paths (dotted, e.g. `meta.active`); arrays are a leaf of type `array` (not element-walked); types = `string|number|bool|null|object|array|objectId|date` (`{$oid}`→`objectId`, `{$date}`→`date`). `uniform=false` if any path is absent from some docs (→ `optionalPaths`) or has >1 type.
  - `validateAgainstShape(docs, shape)` → `{ ok: boolean, missing: string[], unknown: string[], typeMismatch: [{path, expected, got}], failedDocCount }`. Exact-set rule per doc; **`null` is type-compatible in both directions** — an incoming `null` satisfies any expected type, and a path whose reference type set includes `null` accepts any incoming type (a field may legitimately be null on either side). Aggregates distinct offenders across all docs.
- **`src/mdh/importRoute.js`** (or fold into the wizard) — chooses backend by mode, serializes to JSON for MDH, drives the poller.
- **`src/mdh/components/ImportWizard.jsx` / `ImportConfirm.jsx`** — mode routing, `id_keys` picker for Update (reuse `MatchKeyPicker`), shape panel + toggle, async progress, destructive-Replace confirm.
- **Removed for Update/Replace** (kept only if Insert still needs them): `src/mdh/importPlan.js` probe/plan (`buildProbePipeline`, `computePlan`, `analyzeFileKeys`, composite-key logic), `src/mdh/runImport.js` per-row pool (`probeCollection`, `executeImport`'s update/replace branches, `buildUpdateSet`, `buildReplacement`, block-if-non-unique, indexed-prefilter, large-import warning). Insert keeps `runChunkedInsert`/`dedupeById`/`analyzeDocs`. Their tests are removed/trimmed accordingly.

## 5. Shape validation — detail

- **Reference**: sample the target collection (bounded, e.g. up to 500 docs via Data Storage `find`/`$sample`) and `deriveShape`. Sampling risk (a rare field missed) is acceptable given the toggle + the non-uniform warning; documented.
- **Gate**: for each mode, before enabling Go, run `validateAgainstShape(incomingDocs, referenceShape)`. If `!ok` → block Go + show a panel listing `missing` / `unknown` / `typeMismatch` (distinct paths, with counts). If the reference is non-uniform → show the warning + "consider turning validation off" next to the toggle.
- **Toggle**: default ON (`mdhImportValidateShape`); off → skip entirely, Go enabled (subject to normal per-mode checks).
- **Empty/new collection**: no reference → skipped.

## 6. Wizard UX / data flow

1. Pick collection → Import → pick source (File/Clipboard) → parse to docs (existing).
2. Confirm stage: mode segmented control; **Update** shows `MatchKeyPicker` bound to `id_keys` (≥1 required). Shape panel + toggle. Replace shows a strong destructive confirmation.
3. Go:
   - **Insert** → `runChunkedInsert` (Data Storage), client-side progress + exact inserted count (unchanged).
   - **Update/Replace** → serialize docs → JSON Blob → `datasetUpdate`/`datasetReplace` → **async progress** ("Uploading… → Processing (~30–60s)… → Done") via `waitForDatasetOperation`; on `failed`, surface `error`.
4. Summary line: Insert keeps "N new documents"; Update shows "Upsert N rows by `<id_keys>`"; Replace shows "Replace collection with N rows" (no client-side matched/new/skipped preview — server-side now).

## 7. Backward compatibility
- Reused components keep props/testids (`MatchKeyPicker`, wizard shell, source toggle, format parsers). Retired probe/exec modules + their tests are removed.
- No storage-key changes except the new `mdhImportValidateShape`.
- Insert behavior is unchanged.

## 8. Testing
- **`shape.js`** (pure): `deriveShape` (nested paths, type sets, uniform vs non-uniform, optional-path detection, EJSON `{$oid}`/`{$date}` typing, arrays-as-leaf); `validateAgainstShape` (exact-set pass, missing, unknown, type conflict, null-compatibility, multi-doc aggregation).
- **API**: `datasetUpdate`/`datasetReplace` build correct multipart (file + repeated `id_keys` + `update_or_new`), parse `Location`; `waitForDatasetOperation` handles lowercase `finished`/`failed`/`unknown` + transient errors (mocked fetch).
- **Wizard**: routing per mode (Insert→DS, Update/Replace→MDH), shape-block gates Go, toggle bypass, async progress states, Update requires `id_keys`.
- **Live re-verify** on the sandbox during build (throwaway `zz_probe_*` dataset): create/PATCH/PUT/poll/delete, confirming the multipart shape the client emits is accepted.

## 9. Risks
- **Async latency UX**: ~30–60s per Update/Replace. Mitigated by clear progress + the existing op-poll resilience (tolerate transient poll failures, show "still running" not a red error on timeout).
- **Shape sampling** may miss rare fields on huge non-uniform collections → possible over-reject. Mitigated by the non-uniform warning + the toggle.
- **`__digest_md5`/`_id` churn**: records gain `__digest_md5` and updated rows may transiently lack it; `_id`s are server-owned. Accepted; noted so downloads/round-trips aren't assumed stable.
- **Multipart from the extension**: the Console page fetches cross-origin to the org domain with the bearer token (same as today's Data Storage calls) — verify multipart upload works from that context during build.
