# Architect assets

**Date:** 2026-08-24
**Status:** implemented, uncommitted, **never opened in a browser**. Eight tasks and eight fix rounds
are done; every claim below that a test can hold is held by one. §5.6's list of what a human still
has to confirm is the live part of this document, and §5.5 says the same about the panel.
**Area:** `src/fabry/architect/` (a new `assets.ts`, `assetApi.ts`, `assetKeys.ts`,
`assetPrefetch.ts`, `noteText.ts`, `errorText.ts`, `hooks/useFileDrop.ts` + `AssetsPanel.tsx`, plus
`pdfAction.ts`, `store.ts`, `components/SpecView.tsx`, `components/SourceEditor.tsx`,
`components/InspectorRail.tsx`) and `src/docs/` (a new `assetRef.ts`, `assetSync.ts`,
`printAssets.ts`, plus `renderCache.ts`, `components/DocView.tsx`, `printEntry.ts`, `print.css`)

Every example in this document is synthetic. No customer names, file names, collection names or
document ids appear anywhere in it.

## 1. The gap

A deliverable lives in Data Storage, not in a folder, so a file reference inside one has nothing to
resolve against. `![shot](assets/diagram.png)` renders as a broken image and `[sheet](assets/x.xlsx)`
does nothing at all — `DocView` deliberately makes an unresolvable relative link a no-op rather than
letting it navigate the Console away.

The localpages port already recorded this hole. D2 of `2026-08-17-localpages-port-architect-design.md`
dropped local-folder mode, noting that "the source-file viewer, **asset copying** and `security.mjs`
lose their subject", and its §"Static export" admits *"a bundle referencing non-Rossum images is not
fully offline."* D5 re-aimed the source modal at Rossum API resources, which covers hooks, rules,
queues and schemas — but not files.

The Architect already owns deliverables, their state and their history. This makes it own their
files too.

## 2. What this supersedes, and why

An earlier design split the work across two repos: a publisher script in the consuming project
uploaded files and wrote an index; this extension only resolved them. That is dropped. The owner's
call is that assets belong where the deliverables are, which removes three things worth being rid of:

- a repo-path normalisation rule implemented in **two** repos on different release cycles, whose
  first drift would have silently missed every asset;
- per-environment secret handling and a token-bearing script;
- a git revision this extension had no way to verify.

The accepted cost is real and should be stated plainly: **assets are no longer versioned, reviewed
or diffable anywhere.** §7 is how that is made survivable.

## 3. Verified constraints

Live-tested against a Rossum organization and Chrome on 2026-08-24 unless marked otherwise.

| Constraint | Evidence |
|---|---|
| A file can live in Rossum owned by nothing | `POST /api/v1/documents` with **no** `queue` → 201, `annotations: []`. No annotation, no hook run, no queue, no automation statistics |
| Every type we need is accepted | `.png`, `.xlsx`, `.txt`, `.csv`, `.json`, `.xlsm`, `.eml` → all 201, all byte-identical on return (sha256). The documented format list governs extraction, not storage |
| Retrieval is clean | `GET /api/v1/documents/{id}/content` → the bytes, `content-disposition: inline`, detected `content-type` |
| Deletion is clean | `DELETE /api/v1/documents/{id}` → 204. Ceiling is 40 MB (documented) |
| `mime_type` from the API cannot be trusted | A macro-enabled workbook is normalised to the plain spreadsheet mime although the bytes are untouched |
| A bare URL cannot render for a reader | Unauthenticated the content endpoint is 401 with `www-authenticate: Basic realm="api"`; the API token is rejected as Basic credentials in four forms; no session cookie is ever set. **Only something holding the token can fetch — which is precisely why this belongs in the extension** |
| A token-holding fetch is allowed | `access-control-allow-origin` is returned for the org's own origin, nothing for `null` |
| The UI may write | Six modules already write to Data Storage (`RecordEditor`, `bulkOps`, `importFile`, `DataPanel`, `Sidebar`, the export paths). The write-boundary guard in `tests/fabry-write-boundary.test.js` constrains the **agent's** `mcp_mode`, not UI calls |
| The UI may read local files | `Composer.tsx` uses `<input type="file">` + `FileReader`; `src/mdh/importFile.ts` parses a file and chunk-writes it |
| Uploads are permitted | `host_permissions` covers `https://*.rossum.app/*` |
| A folder can be read | `showDirectoryPicker` verified present in Chrome 150 (port spec D2). The panel's **⊞ Folder** button uses it, behind a `typeof … === 'function'` check so the button is absent where it is not |
| A relative reference survives sanitization | `safeSrc` and `safeHref` accept relative paths; `safeSrc` additionally accepts `data:image/(png\|jpe?g\|gif\|webp\|svg+xml)`. No custom scheme is possible |
| Cached render trees are immutable | `renderCache` documents that mutation happens *before* caching and "a cached tree is never touched again" |
| Collapsed content still prints | `theme.css`'s print block forces `details > *:not(summary)` visible |
| Async resolution has a precedent | `renderCache` already causes a second paint for the lazily-loaded diagram bundle |

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Bytes are annotation-free Rossum **documents**; a hidden `_SA_EXTENSION__fabry_architect_assets` collection holds one index row each | Native storage, real filename, 40 MB, no base64 inflation. Data Storage cannot serve bytes to a page at all |
| D2 | The index key is **the reference string the author writes**, and a row may carry **alias** keys | Nothing derives a path, so nothing can drift. Aliases are what let references written before this feature resolve untouched (§6) |
| D3 | Three ingest paths: paste/drop in the editor, a multi-file picker, and a folder picker for bulk | Owner's call. A screenshot pasted while writing is the common case; the folder picker is a one-time bulk import, **not** a two-way sync |
| D4 | The manager is a fifth tab in the **inspector rail**, beside Check, Refine, Implement and History — mounted **unkeyed** | The rail follows the deliverable being read, so the list can lead with what that section references. Every other panel mounts `key={d.id}`; an org-wide list must not, or every scroll between sections would discard the filter text, the upload log and any open delete confirmation. It would refetch only after a FAILED read — a successful one is memoised in the singleton store (§5.4) — so the state, not the request, is what the key would cost |
| D5 | Ships ungated | Owner's call. The upload path writes only to the org the user is already authenticated against |
| D6 | An **export** action is required, not optional | With no git archive and no cross-org copy (D3), an asset otherwise exists in exactly one place |
| D7 | The index's `mime` and `name` beat anything the API reports | The normalised-workbook finding in §3 |
| D8 | A miss is always visible | Reuse `.state-label.state-error`, the pill `docWarnings` already uses for "renders as nothing" |
| D9 | Identical bytes upload once | sha256 is computed before upload; a matching row reuses its document and just adds an alias |

## 5. Design

### 5.1 The index row

```json
{
  "_id": "assets/diagram.png",
  "kind": "asset",
  "documentId": 1234,
  "mime": "image/png",
  "name": "diagram.png",
  "size": 10240,
  "sha256": "…",
  "aliases": ["https://example.test/older/path/diagram.png"],
  "uploadedAt": 1787000000000
}
```

`kind: 'asset'` keeps these invisible to `loadDeliverables`, which queries `kind: 'requirement'` —
the same additive trick revisions already use.

An earlier draft of this row carried **`uploadedBy`**, and it is struck rather than built: the store
has no user-identity signal to write it from — nothing in the extension resolves the authenticated
user's address — so it would have been a field that is always absent, which is worse than a field
that is not there. **`uploadedAt`** IS written (`Date.now()` at upload) and is read by nothing today:
no panel column, no sort, no filter. It stays because it costs one number and is the only thing that
could ever date a file, and it is recorded here so nobody mistakes it for a live input.

### 5.2 Upload

Read the file, hash it, look for a row with that sha256.

- **On a hit** (D9), add the new key as an alias to that row and stop. The row is *replaced*, with
  `upsert: false`: it may have been deleted since the read that found it, and re-creating it would
  publish a reference to a document the same delete removed. Where the service reports a zero match,
  that silence is surfaced as a failure; the guarantee comes from the flag, never from the count.
- **On a miss**, `POST /api/v1/documents` with no `queue`, then **insert** the row. Document first,
  row second: the reverse would leave a row pointing at nothing, which a reader sees as a broken
  asset.

The new row is an INSERT, never an upsert, and that is the whole safety property of the write path.
The index key is allocated against the last read, which can be arbitrarily old — a successful read
is memoised (§5.4) and an Architect tab is long-lived — so another session may have taken that key
since. `_id` carries Mongo's mandatory unique index, so an insert against a taken key fails; an
upsert would overwrite it, orphaning that session's document and leaving every existing reference to
the key serving these bytes, with no error anywhere. No check can close this: a check goes stale, the
operation cannot.

A failed insert is read as "the row was not written", whatever the service returned — the recovery is
correct either way, so nothing depends on classifying the error. The index is re-read.

A failure is not evidence the row is *absent*, though: the client abandons a request after 30 s and a
gateway can fail after the commit, neither of them saying what the server did. So the re-read is
first checked for our own row — our key carrying our `documentId`, which is server-assigned per POST
and so cannot be anyone else's — and that row is adopted as the upload's result. Re-keying past it
would leave one document with two rows, neither carrying the other as an alias, which is precisely
what aliases exist to prevent: a later delete of either row takes the shared document and strands the
other, and every reference to it renders as unpublished. Only when our row is not there is the key
re-allocated against what is now known to be taken and the insert retried **once**. A second failure
is reported.

A crash between the two writes, or a collision that survives the retry, leaves a document no row
references — wasted storage, invisible to readers, and deliberately not auto-deleted, because "has no
annotation and is not in our index" is not a safe enough test to delete a document on. The panel
reports it instead.

### 5.3 Inserting the reference

On paste or drop into the editor, upload, then insert `![name](assets/name)` at the cursor for an
image and `[name](assets/name)` otherwise. The key is derived from the filename and de-duplicated
against existing keys with a `-2`, `-3` suffix, exactly as `assignSlugs` does for deliverables. That
`taken` set includes aliases, which has an author-visible consequence — see "Knowingly not covered"
in §5.6.

### 5.4 Resolution

`assets.ts` exposes `lookup(href)` (synchronous, off the index read once at boot), `peek(href)` (a
cached object URL, a held failure, or null — synchronous and side-effect-free), `resolve(href)`
(fetch once, memoised per key while in flight), `pin(hrefs)` and `version()`.

**The cache is bounded by total bytes, and it is FIFO, not LRU.** A workbook and an icon are not the
same cost, so a count-based cap would happily hold twenty workbooks. But `resolve` deliberately does
not refresh recency on a hit, so eviction walks insertion order — and **a pinned entry is skipped
entirely.** In the ordinary case the pinned set *is* the whole specification's asset set, because
every deliverable renders into one scroller, so the 8 MB cap does not bind at all. That is ruling
16's accepted trade, stated at `assets.ts`'s `evict`: a document holds what it is currently
displaying, bounded by its own asset set rather than by an arbitrary byte figure.

**`renderDocument` does NOT take an `assets` option, and no asset version reaches the cache key.**
An earlier draft of this section prescribed both (ruling 13) and ruling 15 removed them, for two
reasons worth keeping written down so nobody rebuilds it:

- an asset's availability is per-store, per-moment state, not a property of the rendered text — and
  this cache is shared by every caller, so keying on it made every warmed entry unmatchable the
  instant any caller supplied a store, killing the preload that exists to make a deliverable switch
  instant;
- a bumped version routed every completed fetch through the effect that owns the source-preview
  modal, **closing that modal out from under the reader.**

What ships instead is a targeted live-DOM patch, in two halves that share nothing but an attribute:

1. `renderCache.markAssetRefs`, on the detached tree before it is cached, rewrites every image the
   browser cannot fetch on its own (`assetRef.needsAssetStore`) to `<img data-asset-ref="…">` with
   **no `src`** — so nothing requests an unresolvable path, and the cached tree knows nothing about
   any store.
2. `assetSync.syncAssets(root, store)` runs over the **live** DOM, in `DocView`'s own effect keyed on
   `[rendered, assetsVersion]`. It is idempotent and **bidirectional**: not-published ↔ index-error ↔
   unavailable ↔ resolved, in either direction, so an asset self-heals when a retry succeeds and an
   image whose object URL was evicted becomes a pill rather than a broken picture. It is the only
   place that calls `resolve()`, and at the end of every pass it hands the store the refs it painted
   as the **pinned** set, replacing the previous one wholesale (ruling 16) — merge it and nothing
   would ever become evictable again.

`version()` is a `@preact/signals` signal, and it is `DocView` **reading** it during render — not the
number — that turns "a fetch landed" into a second paint. The panel reads the same one.

**A self-heal from a pill loses the authored attributes.** `syncAssets` sets `src`/`title` on an
existing `<img>` precisely so that a resolve keeps the `alt`, `class`, `width`, `height` and `align`
the sanitizer allowed through. A pill, though, never carried them — it is a `<span>` this module
built — so healing a pill has to build a fresh `<img>`, and the authored `width` of a picture that
was briefly unavailable is gone until the deliverable is re-rendered from its text. Accepted:
re-rendering on every heal would put the asset back into the cache key this section just removed.

Files resolve on **click**, not on render — fetching a workbook nobody opened would spend the
reader's bandwidth on every paint. A click on a file reference **downloads** it under the row's own
filename (`assetApi.downloadAsset`); it does not preview it. An earlier draft had `formatResource`
grow a mime-aware branch so the source-preview modal could show an image or a text file instead of
JSON-parsing binary into noise; nothing was ever wired to it, and the branch has been **deleted**
rather than left as a boundary nothing crosses.

### 5.5 The panel

The **mockup** was approved — built with the pane's own tokens — so the shape below is settled rather
than sketched. **The built panel has never been seen in a browser.** 265 lines of new CSS, the
hover-reveal action row, the drag highlight, three group headers, the log rows and the
delete-confirmation strip: jsdom has no layout, so no test in this suite can evaluate any of it. That
belongs beside §5.6's list, and it is the largest unverified surface in the feature.

A header line — `7 files · 654 KB` — and an **Add files** button. Below it a name/type filter, then the
list in **three groups**, which is the whole reason the rail is the right home:

| Group | Contents |
|---|---|
| **In this section** | referenced by the deliverable currently in view |
| **Elsewhere** | referenced by other deliverables, which are named |
| **Referenced by nothing** | orphans, marked with a warning-tint `unused` pill |

Each row is a monospace extension chip, the name, and `size · refs`. Hover reveals three icon
actions: copy reference, download, delete. The **whole panel body is the drop target**, not a strip.

Three states carry the risk, and each is visible rather than silent:

- **Upload** shows a progress row; a file whose sha256 already exists shows a `reused` pill instead
  of uploading twice (D9), so de-duplication is something the user sees rather than something that
  quietly happens.
- **Delete** lists the deliverables that still reference the file and then still allows it —
  informed, not blocked.
- **Paste** inserts the reference at the cursor and reports the batch in the document bar's note.
  Not a toast, and it does not time out: an upload failure stays there until the reader dismisses it
  with the strip's ×, because for a file pasted into the editor that note is the only record there
  is — the panel's log never sees this path. The newest five failures are named and older ones
  counted (`noteText.ts`). Every other writer to that one slot, the PDF flow included, carries the
  undismissed failures along instead of replacing the line — and a **success** clears only its own
  line, never what is held: dismissal is the one thing that empties the carrier.

  There are four writers now, so the rule is a function rather than four careful call sites. The PDF
  flow OWNS the `'busy'` sentinel and is the only writer allowed to replace it; every other writer
  goes through `noteText.keepBusy`, which defers. Without that, clicking an asset link during a
  multi-second `runPdf` re-enabled the PDF button, flipped its label back from `Preparing…`, and let
  a second print start on top of the first.

The orphan group is not decoration: with no repository copy (§2), the panel is the only place that
can answer "what would I lose if I deleted this?"

**Which is why the count is taken from the RENDERER, not from the text.** The reference list behind
those three groups comes from rendering each deliverable and reading the `<img>` and `<a href>` sets
off the result — `buildSpecSections` and then `printAssets.collectAssetRefs`, the same function the
print path scans the assembled specification with. A markdown regex was tried and was wrong twice: it
matched only inline `!?[…](…)`, so a raw `<img src="assets/diagram.png" width="600">` — the only way
to fix a width, and something `sanitize.ts` allows on purpose — and reference-style `![a][ref]` both
rendered, both printed, and both read as **zero** references here. The panel then filed the file
under "Referenced by nothing", pilled it `unused`, and its delete confirmation *said* "Referenced by
nothing" about a file that was referenced. That is a destructive write on a false report, at the one
place this section calls load-bearing, and per §2 the bytes exist in exactly one place.

One home for that scan was never the invariant that mattered; one **answer** is. A question asked of
the renderer's own output cannot drift from the renderer, and a fenced example of the syntax is still
not a reference because the renderer turns it into `<code>`. A deliverable the renderer could not
process at all is **counted, not read as empty** — the confirmation says how many were unscanned
rather than asserting past them. The cost is one extra markdown render per deliverable, memoised on
the deliverable list, which is the same order of work the Preview column already does.

### 5.6 Print

The print path shares nothing with the on-screen one, and everything below follows from that.
`pdfAction.runPdf` builds its **own** renderer, so `renderCache`'s `markAssetRefs` never runs and a
relative image reaches the printed HTML with its authored `src` intact; and `buildPrintDocument`
returns a **string** that crosses `chrome.storage.session` into a **different tab**, so `assetSync`'s
live-DOM patch has no DOM to patch and the `blob:` URLs it paints would be dead on arrival — an
object URL belongs to the Console's context. The only thing a printed image can carry is its own
bytes.

So: assemble, prefetch, inline. `buildPrintDocument` is untouched and still pure.

1. `collectAssetRefs(html)` (`src/docs/printAssets.ts`) — every reference the assembled document
   makes, one entry per distinct href, carrying `images`: how many `<img>` elements hold it. It reads
   the RENDERED HTML rather than re-scanning the markdown, where `<img>` versus `<a>` would have to be
   re-derived and fenced examples got right a second time. No URL policy lives here; the one
   exclusion is the `#` permalink anchor markdown-it-anchor puts on every heading, and it applies to
   LINKS only — markdown-it-anchor never emits an `<img>`, and an `<img src="#x">` is marked on
   screen, so excluding it here would re-open the divergence below.

   `images` is one number rather than a boolean plus a count because the two facts are the same fact
   and two fields would be free to drift: `images > 0` is "this needs bytes at all", and `images` is
   how many copies of the `data:` URI `inlinePrintAssets` will stage.
2. `prefetchAssets(store, refs)` (`src/fabry/architect/assetPrefetch.ts`) — one `resolve` per
   distinct image href, and each one's bytes are read the moment it resolves. **Sequential on
   purpose:** the store evicts by total bytes, so resolving everything first would revoke the earlier
   object URLs before they were read (`evict` never touches the entry it was called for, which is
   what makes resolve-then-read safe). It never calls `pin` — the pinned set belongs to whichever
   `syncAssets` pass ran last (ruling 16), and replacing it from here would unpin what the reader is
   looking at. A linked file is never fetched at all: paper cannot follow a link, so its filename is
   all that can survive the trip.
3. `inlinePrintAssets(html, assets)` — fills in each `data:` URI, prints each filename beside its
   link, and replaces anything it could not prepare with a `.print-asset-missing` marker naming the
   reference and the reason. With nothing to inline it returns the input byte-for-byte.

**One rule for what an image reference IS, in `src/docs/assetRef.ts`.** `needsAssetStore(href)` —
anything that is not `http(s):`, `data:` or protocol-relative — is applied by `renderCache` on screen
and by `prefetchAssets` on paper. It had been written out twice, and the two disagreed: the print side
gated on `assetKeys.cleanHref`, which additionally rejects a leading `/` and a leading `#`, so
`![architecture](/assets/architecture.png)` was a red pill NAMING the file on screen and, on paper, no
picture, no marker and no warning — the reader of that PDF could not know a diagram had been meant to
be there. Its own module, in `src/docs/`, because `src/fabry/architect` imports from `src/docs` and
never the reverse, and because whichever of `renderCache.ts` or `printAssets.ts` owned it the other
would have to import across that boundary. `cleanHref` still governs LINKS, and deliberately: the
screen marks no link, so there is nothing there to bring into line.

A schemed `src` (`file:`, `mailto:`) never reaches either rule — `sanitize.ts`'s `safeSrc` strips it
first, on both paths — so the two always agreed there, and both show an empty `<img>`.

**The budget, which is new.** `chrome.storage.session` is capped at 10 MB under MV3, the per-asset
upload ceiling is 40 MB (§3), and base64 inflates by a third — so one screenshot can be 53 MB of
text. Nothing in this repo handled that: it would have surfaced as `runPdf`'s catch reporting
"could not open the print view: `<opaque storage error>`", losing the entire specification
because of one picture. Refusal is projected from `row.size` (base64 is exactly 4 characters per 3
bytes) so an oversized asset is refused **before** its bytes are read, then re-checked against the
real encoded length in case the index row understated it.

**The budget is derived, not declared.** `PRINT_ASSET_BUDGET` (6 MB of `data:` URI characters) is now
a CAP, and the figure the prefetch is actually given is
`printAssetBudget(html) = min(cap, 10 MB − JSON.stringify(html).length − 64 KB)`, computed in `runPdf`
where the assembled markup is in hand. A constant could not bound what is staged: the quota is shared
between the markup and the assets, and a specification's own HTML is not small — mermaid bakes as
inline SVG, so a diagram-heavy one passes 4 MB on its own. 4 MB of markup plus a full 6 MB of assets
overruns the quota, `set` rejects, and the whole specification is lost to that same opaque catch.
"Far more than a long one weighs" was an assertion in an earlier draft of this section, and it was
the one half of the quota claim that could be checked offline.

Measured on `JSON.stringify`, because the entry is serialized and HTML is quote-heavy — every
attribute quote costs two characters. A base64 payload carries nothing JSON has to escape, which is
why the assets themselves are still charged one for one. The 6 MB cap stays on top so a short
specification does not suddenly get to stage ~9 MB in a single value, which is the size question no
offline test can settle (see the human-verify list below). The derived figure only ever tightens.

**Charged per `<img>`, not per href.** `inlinePrintAssets` writes the URI into every element carrying
the reference, so a specification that repeats one 2.5 MB screenshot in three sections stages ~10.2 MB
— and a budget charged once per href reports 3.4 MB of 6 MB spent while doing it, blowing the quota
and losing the whole document to that same opaque catch. Both checks and the running total multiply
by `images`.

**The 10 MB figure has a floor.** `chrome.storage.session`'s quota was **1 MB** before Chrome 112; on
an older build a 6 MB budget is 6× over and every asset-bearing print fails opaquely. That was an
undeclared assumption, so `manifest.json` now declares `minimum_chrome_version: "114"` — the floor the
manifest already implied, since the `side_panel` key needs 114 — and
`tests/architect-asset-prefetch.test.ts` asserts it stays at or above 112, beside the budget that
depends on it.

**Degradation is per asset, never per document.** Everything that fits is printed; everything that
does not — over budget, not published, a mime paper cannot show, a failed resolve, a failed read —
is named twice: on the page where the picture would have been, and in the document bar through
`onWarnings`. Silence is the one unacceptable outcome. `onNote('busy')` stays a bare sentinel,
because `SpecView` keys the PDF button's disabled state and its label off that exact literal.

"Not published" is a claim about the FILE, so it is not used for an index nobody could read:
`prefetchAssets` reads the store's `indexError` (and catches a throwing `lookup`) and says "the file
index could not be read (…)" instead. Collapsing the two blames the asset for the index's failure.

**The screen says the same sentence, and for one round it did not.** `lookup` returns null both for a
file nobody uploaded and for an index nobody could read, and `AssetSyncStore` exposed no way to tell
them apart — so the pill machine painted `not published` unconditionally while the printed page told
the truth. A token that expires, or one 502 on the boot `find`, made every image in the document
column read "— not published", whose honest reading is "nobody uploaded these" or "somebody deleted
them"; `ArchitectApp`'s load effect runs once, so nothing re-reads, and recovery needed a rail tab
the reader may never open. `AssetSyncStore` now declares an optional `stats`, `syncAssets` has a
**third** pill state, and `tests/asset-ref-rule.test.ts` drives one store in one state down both
pipelines and asserts the two sentences are identical — rather than comparing two hand-written
strings, which is how the rule came apart the first time (ruling 33's shape, polarity reversed).
A failed FETCH keeps its own `unavailable`: that is a per-asset failure whatever the index is doing.

Only the mimes `sanitize.ts`'s `safeSrc` accepts as a `data:` image are inlined, so the staged HTML
stays HTML the sanitizer would have passed — the print page injects it with no sanitizer of its own.

**The print page waits for its pictures.** `printEntry.ts`'s `whenImagesSettle` awaits `load`/`error`
on every `<img>` before the two `rAF` and `window.print()`, with a 5 s ceiling so one image that never
settles cannot hold the dialog shut. New with this task: until now no image ever reached that page, so
`document.fonts.ready` plus two frames was the whole of "laid out", and a multi-megabyte `data:` URI
decodes on the same renderer with nothing awaiting it.

**Knowingly not covered.** An asset referenced by an ABSOLUTE URL (the §6 alias case) is left exactly
as it is on screen: a network fetch by the print page, which for a Rossum document endpoint is a 401.
`DocView`'s hover preview builds its own renderer with no store, so a sibling document's image is
still broken in that card.

And **phantom aliases inflate the next key's suffix.** D9 says identical bytes upload once, so a
second upload of the same file adds its allocated key to the matching row as an alias — but the
editor inserts `row.key`, not the alias, so nothing ever references it. Each phantom still occupies a
name in the `taken` set the next allocation is made against, so after three duplicate uploads of
`image.png` a genuinely new `image.png` is keyed `assets/image-4.png` rather than `assets/image-2.png`
— author-visible in the deliverable text. It is not a leak: the inserted reference resolves, and
`remove()` cleans a row and its aliases together. Inserting `row.key` is still the right choice of the
two, and D9 is a design ruling, so this is left alone as cosmetic. It is written down here because
§5.2 and D9 describe the aliasing that causes it and never mentioned the consequence.

**A human has to confirm, in a real browser** — none of these can be exercised offline:

1. Whether Chrome accepts a single `storage.session` **value** of this size, as opposed to the
   documented 10 MB per-AREA cap. If it does not, the budget needs the smaller of the two.
   `printAssetBudget`'s 6 MB cap is what limits the exposure until somebody looks.
2. That the print dialog visibly opens **after** the pictures have painted. `whenImagesSettle` is
   unit-tested (`tests/docs-print-image-wait.test.ts`); its one caller is `boot()`, which runs on
   import against `chrome.storage.session` and `location.search` and has no test harness here.
3. That a printed page's `.print-asset-missing` marker and `.print-asset-file` tag are legible on
   paper. jsdom has no layout, so no test in this suite can see a stylesheet regression. Both now
   carry a `prefers-color-scheme: dark` pair, which matters for the on-screen print preview.
4. That reading an object URL back with `fetch` is permitted on the Console page. The manifest
   declares no `content_security_policy`, and MV3's default extension CSP constrains `script-src` and
   `object-src` — a `fetch` is `connect-src`, so the conclusion is probably right, but it was argued
   from the wrong directive once and has never been run.
5. **The whole Assets panel** — see §5.5. Nothing in jsdom can evaluate a stylesheet, a hover reveal
   or a drag highlight.

### 5.7 Export

One button beside the filter box, and **the action follows the filter** — a reader who has narrowed
the list to three files and presses it means those three, and the label says so
(`⤓ Download 3` / `⤓ Download all`). Ruling 20 replaced per-row selection with that: a selection
model is a second piece of state to keep in step with a filter that is already the reader's way of
saying which files they mean.

Sequentially, under each file's original filename — the browser-download pattern
`src/mdh/downloadCollection.ts` establishes, rather than a zip dependency. It is the escape hatch D6
requires, so its failures are named and not just counted: the note carries the first few distinct
reasons and counts the rest, because "3 of 3 could not be downloaded" is not something a reader can
act on and there is no other channel for it.

## 6. Backward compatibility

- **References written before this feature keep working.** One project's deliverables carry roughly
  thirty absolute URLs from an earlier workaround; registering each as an `alias` on the matching row
  resolves them with **no edit to any deliverable**. No migration pass, no text rewrite.
- **Older extension builds are unaffected.** `kind: 'asset'` rows are invisible to their
  `kind: 'requirement'` query, and an older build simply does not resolve a reference — it renders
  exactly as it does today. Purely additive, like `titleSource` and `state` before it.
- **The index collection is new**, so there is nothing to migrate and nothing to rename.
- **Deliverable text is never rewritten by this feature**, so nothing it does can corrupt a document.

## 7. Risks

| Risk | Mitigation |
|---|---|
| An asset exists in one place only (no git, no cross-org copy) | D6's export action; and the panel makes "what would I lose" answerable at a glance |
| Rossum may purge documents that belong to no annotation — **unverified** | A canary document was uploaded during the feasibility test; re-check it periodically before anyone depends on this. If purging happens, D6's export is the only recovery |
| An asset is deleted while still referenced | The panel resolves referenced-by before deleting and names the deliverables |
| Promotion to another organization means re-uploading | Accepted for v1 (D3). The folder picker is the fallback path |
| Hiding is not access control | Anything with the org token can read the index and the documents, exactly as it can read the deliverables |

## 8. Non-goals

Cross-organization copy. Two-way folder sync. Editing bytes in place. Any git involvement — one
consuming project keeps a JSON contract in its repo because its CI reads it, and that file simply
stays there; it is not this feature's business.

## 9. Open questions

1. **Retention** of annotation-free documents (§7). The one fact that could undermine the approach.
2. ~~Whether the panel offers **replace** — new bytes under an existing key, keeping references
   intact — in v1.~~ **Answered: it does not.** Delete-then-upload is the path, and the panel names
   what still references a file before allowing the delete (§5.5). A replace would need a third write
   shape — a document POST plus a row UPDATE, with the old document deleted only after both land —
   and the safety property of §5.2's write path is that the row write is an INSERT that cannot
   overwrite. That is not a v1 shape.
