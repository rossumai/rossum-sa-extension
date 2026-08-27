import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../store.js';
import { downloadAsset } from '../assetApi.js';
// This panel is the ONLY place an upload failure is ever reported, so a `failed` row carrying no
// detail is a failure the user is told about without being told anything.
import { message } from '../errorText.js';
import { collectAssetRefs } from '../../../docs/printAssets.js';
import { buildSpecSections } from '../../../docs/specDocument.js';
import { createMarkdownRenderer } from '../../../docs/render.js';
import { displayTitle } from '../format.js';
import { formatBytes } from '../../../mdh/indexDef.js';
import useFileDrop from '../hooks/useFileDrop.js';
import type { AssetRow } from '../assets.js';

// The organization's files, managed from the inspector rail (design 2026-08-24, D4/§5.5).
//
// The rail follows the reader's scroll, which is the whole reason this list lives here rather
// than in a modal: it can lead with the files the deliverable in view references, and re-sort
// itself as the reader moves. That is what `groupAssets` is, and it is the part with a unit test.

type AssetStore = typeof store.assets;

/** A folder import of 200 files must not stack 200 rows above the list. The tail is what a reader
 * watches; everything older is accounted for by a count rather than dropped silently. */
const LOG_CAP = 12;

/** Failures survive LOG_CAP, but they are not unbounded: past this many the oldest are counted —
 * and counted separately, because "N earlier" reads as "nothing went wrong". */
const FAILED_CAP = 50;

/** Shown on the controls an unreadable index takes away, and on a drop it turns down. */
const BLOCKED = 'Uploading needs the file index. Retry the read above first.';

/** Distinct reasons named in the download-all note before the rest become a count. */
const REASON_CAP = 3;

const SECTIONS: ['here' | 'elsewhere' | 'unused', string][] = [
  ['here', 'In this section'],
  ['elsewhere', 'Elsewhere'],
  ['unused', 'Referenced by nothing'],
];

export function groupAssets(
  rows: AssetRow[],
  refsByKey: Record<string, string[]>,
  currentId: string | null,
) {
  const here: AssetRow[] = [];
  const elsewhere: AssetRow[] = [];
  const unused: AssetRow[] = [];
  for (const r of rows) {
    const refs = refsByKey[r.key] || [];
    if (!refs.length) unused.push(r);
    else if (currentId && refs.includes(currentId)) here.push(r);
    else elsewhere.push(r);
  }
  return { here, elsewhere, unused };
}

// Ruling 38: ONE ANSWER, not just one home. This panel gates a DELETE, and the bytes exist in
// exactly one place (design §2), so "Referenced by nothing" has to be true of the same document the
// reader sees. A markdown regex could not be: `!?[…](…)` misses a raw `<img src="assets/x.png"
// width="600">` — the only way to fix a width, and `sanitize.ts` allows `img` with
// `width`/`height`/`align` on purpose — and it misses reference-style `![a][ref]`. Both render, both
// print, and both read as ZERO references here. A regex is free to drift from the renderer; a
// question asked OF the renderer's own output cannot.
//
// So the scan runs the same chain the screen and the paper run — `buildSpecSections` (markdown-it,
// `wrapStandaloneImages`, the sanitizer) and then `collectAssetRefs` over the rendered HTML, which is
// the SAME function `pdfAction` scans the assembled specification with. One deliverable at a time,
// so one unrenderable document cannot blank the whole answer, and a fenced example still cannot
// count: the renderer turns it into `<code>`, not into a link.
let renderer: { render: (text: string, env: any) => string } | null = null;

/** Every reference ONE deliverable makes, read off what the renderer produced. Images and links
 *  alike, exactly as the print path collects them — callers filter with `lookup`. */
export function refsInRendered(text: string): string[] {
  renderer = renderer || createMarkdownRenderer();
  const { sections } = buildSpecSections({
    deliverables: [{ id: 'scan', text: String(text ?? '') }],
    md: renderer,
  });
  return collectAssetRefs(sections[0].bodyHtml).map((r) => r.href);
}

/** Every deliverable's references, and how many could not be rendered at all. Kept apart from
 *  `refsByAssetKey` because rendering is the expensive half and only the deliverables change it —
 *  the cheap half re-runs on every index version, which is what makes a newly loaded row resolve. */
export function scanRefs(
  deliverables: { id: string; text?: string }[],
  refsIn: (text: string) => string[] = refsInRendered,
): { scanned: { id: string; hrefs: string[] }[]; unscanned: number } {
  const scanned: { id: string; hrefs: string[] }[] = [];
  let unscanned = 0;
  for (const d of deliverables || []) {
    try {
      scanned.push({ id: d.id, hrefs: refsIn(String(d.text || '')) });
    } catch {
      // Counted, never swallowed: a deliverable whose references are unknown must not be reported
      // as a deliverable that references nothing, which is the false report this whole scan exists
      // to remove.
      unscanned += 1;
    }
  }
  return { scanned, unscanned };
}

/**
 * Which deliverables reference each row, keyed by ROW key — resolved through the store's own
 * `lookup`, so an alias (a reference written before this feature existed) counts as a reference
 * to the file it resolves to instead of reading as an orphan.
 */
export function refsByAssetKey(
  scanned: { id: string; hrefs: string[] }[],
  lookup: (href: string) => { key: string } | null,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of scanned || []) {
    const seen = new Set<string>();
    for (const href of d.hrefs) {
      const row = lookup(href);
      if (!row || seen.has(row.key)) continue;
      seen.add(row.key);
      (out[row.key] || (out[row.key] = [])).push(d.id);
    }
  }
  return out;
}

function extChip(name: string): string {
  const i = String(name || '').lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : 'file';
}

// A folder picker is a ONE-TIME bulk import, not a two-way sync (D3). Depth-capped so a
// mistakenly picked home directory cannot walk forever.
async function collectFiles(dir: any, out: File[], depth = 0): Promise<void> {
  if (depth > 3) return;
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') out.push(await entry.getFile());
    else if (entry.kind === 'directory') await collectFiles(entry, out, depth + 1);
  }
}

type LogRow = {
  id: number;
  name: string;
  state: 'uploading' | 'added' | 'reused' | 'failed';
  detail?: string;
};

const LOG_LABEL: Record<LogRow['state'], string> = {
  uploading: 'uploading…',
  added: 'added',
  reused: 'reused',
  failed: 'failed',
};

export type Log = { rows: LogRow[]; earlier: number; earlierFailed: number };
const EMPTY_LOG: Log = { rows: [], earlier: 0, earlierFailed: 0 };

/**
 * LOG_CAP, applied to the whole log after every change.
 *
 * A `failed` row is exempt: this panel is the only place an upload failure is ever reported, so a
 * failure the cap collapsed into "N earlier" is a failure nobody ever hears about. An `uploading`
 * row is exempt for the same reason one step earlier — its outcome is not known yet, and dropping
 * it drops the failure it may turn into (a second batch, started by a drop mid-import, can push a
 * row out before its own upload has settled). Successes are what collapse into a count.
 */
export function capLog(l: Log): Log {
  const settled = l.rows.filter((r) => r.state === 'added' || r.state === 'reused');
  const failed = l.rows.filter((r) => r.state === 'failed');
  const dropFailed = Math.max(0, failed.length - FAILED_CAP);
  const drop = Math.max(0, settled.length - Math.max(0, LOG_CAP - (failed.length - dropFailed)));
  if (!drop && !dropFailed) return l;
  const gone = new Set([
    ...settled.slice(0, drop).map((r) => r.id),
    ...failed.slice(0, dropFailed).map((r) => r.id),
  ]);
  return {
    rows: l.rows.filter((r) => !gone.has(r.id)),
    earlier: l.earlier + drop,
    earlierFailed: l.earlierFailed + dropFailed,
  };
}

/** The tail counter. A failure is never just "earlier": how many failed is the part a reader has
 *  to be able to act on. */
export function logTail(l: Log): string {
  const parts = [
    l.earlierFailed ? `${l.earlierFailed} failed` : '',
    l.earlier ? `${l.earlier} earlier` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' · ')}, not shown` : '';
}

/** The note is one line, so the first few distinct reasons are named and the rest counted — the
 *  same shape `noteText.ts` uses for held upload failures, for the same reason: a cause collapsed
 *  into a number is a cause nobody can act on. */
export function reasonList(reasons: string[]): string {
  const shown = reasons.slice(0, REASON_CAP);
  const rest = reasons.length - shown.length;
  return [...shown, rest ? `${rest} other reason${rest === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
}

export default function AssetsPanel({
  currentId = null,
  assets = store.assets,
  download = downloadAsset,
}: {
  currentId?: string | null;
  assets?: AssetStore;
  download?: (s: AssetStore, href: string) => Promise<string | null>;
}) {
  // Read UNCONDITIONALLY, every render: `version()` reads a @preact/signals signal, and it is
  // that read — not the number — which repaints this panel when the index changes under it (an
  // upload, a delete, a resolve). DocView reads the same one for the same reason.
  const indexVersion = assets.version();
  const [filter, setFilter] = useState('');
  const [log, setLog] = useState<Log>(EMPTY_LOG);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);
  // A COUNT, not a flag: a drop landing during a folder import starts a second batch, and the
  // inner one finishing must not report the outer one as done.
  const batches = useRef(0);

  // A SUCCESSFUL read is memoised in the store, so asking again costs nothing: the Architect also
  // loads the index at boot (ArchitectApp), because the document column needs it whether or not
  // this tab is opened. A failed one is not memoised — that is what Retry below asks for.
  useEffect(() => {
    assets.load();
  }, [assets]);

  const rows = useMemo(
    () => [...assets.entries()].sort((a, b) => a.key.localeCompare(b.key)),
    [assets, indexVersion],
  );
  const ds = store.deliverables.value;
  const scan = useMemo(() => scanRefs(ds), [ds]);
  const refsByKey = useMemo(
    () => refsByAssetKey(scan.scanned, assets.lookup),
    [scan, assets, indexVersion],
  );
  const titles = useMemo(() => new Map(ds.map((d) => [d.id, displayTitle(d)])), [ds]);

  const q = filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => (r.key + ' ' + r.name).toLowerCase().includes(q)) : rows;
  const groups = groupAssets(shown, refsByKey, currentId);
  const total = rows.reduce((n, r) => n + (r.size || 0), 0);
  const indexError = assets.stats().indexError;
  // The store REFUSES an upload it could not read the index for: a key allocated against an index
  // nothing read is allocated against nothing, so the insert fails on the first name already
  // published and the document is uploaded for no row. This is what stops a user walking into that
  // refusal in the first place.
  const blocked = !!indexError;
  // The whole panel body is the drop target (design §5.5), which is why the dragging state paints
  // the panel rather than a strip inside it. Shared with the source editor — see useFileDrop.
  const { dragging, handlers } = useFileDrop({
    onFiles: (files) => void addFiles(files),
    enabled: !blocked,
    onRefused: () => setNote(BLOCKED),
  });
  const tail = logTail(log);
  const folderPicker = typeof (window as any).showDirectoryPicker === 'function';

  function names(key: string): string {
    return (refsByKey[key] || []).map((id) => titles.get(id) || id).join(', ');
  }

  // The one sentence a delete is decided on, so it may not claim more than the scan knows. A
  // deliverable that could not be rendered has UNKNOWN references, not none.
  function confirmText(key: string): string {
    const who = names(key);
    return (
      (who
        ? `Still referenced by ${who}. Those references will show as not published.`
        : 'Referenced by nothing.') +
      (scan.unscanned
        ? ` ${scan.unscanned} deliverable${scan.unscanned === 1 ? '' : 's'} could not be scanned for references.`
        : '')
    );
  }

  // Both go through `capLog`: an `uploading` row is exempt from the cap, so the moment it settles
  // is the moment it becomes cappable, and that moment is here.
  function mark(id: number, patch: Partial<LogRow>) {
    setLog((l) =>
      capLog({ ...l, rows: l.rows.map((e) => (e.id === id ? { ...e, ...patch } : e)) }),
    );
  }

  function append(row: LogRow) {
    setLog((l) => capLog({ ...l, rows: [...l.rows, row] }));
  }

  async function addFiles(list: FileList | File[] | null | undefined) {
    const files = [...(list || [])];
    if (!files.length) return;
    setNote(null);
    batches.current += 1;
    setBusy(true);
    try {
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const id = (seq.current += 1);
        append({ id, name: f.name, state: 'uploading' });
        try {
          const { reused } = await assets.upload(f);
          mark(id, { state: reused ? 'reused' : 'added' });
        } catch (err) {
          mark(id, { state: 'failed', detail: message(err) });
          // A token that expires at file 12 of a 200-file folder import refuses all 188 that
          // follow, one round-trip at a time, with Retry disabled for the whole march (a read is
          // queued behind every upload in the batch). Nothing was ever lost — every file gets its
          // own named `failed` row — but there was no rule that said "the index is gone, stop".
          // Read from the store rather than matched against the refusal's text: `indexError` IS
          // the condition `uploadNow` refuses on, and it is set for the rest of the batch because
          // a failed read is deliberately not memoised.
          const gone = assets.stats().indexError;
          if (gone) {
            const skipped = files.length - i - 1;
            setNote(
              `Stopped: ${gone}` +
                (skipped ? ` · ${skipped} file${skipped === 1 ? '' : 's'} not attempted` : ''),
            );
            break;
          }
        }
      }
    } finally {
      batches.current -= 1;
      if (!batches.current) setBusy(false);
    }
  }

  async function addFolder() {
    const pick = (window as any).showDirectoryPicker;
    let dir: any = null;
    try {
      dir = await pick.call(window);
    } catch {
      return; // cancelled
    }
    const found: File[] = [];
    try {
      await collectFiles(dir, found);
    } catch (err) {
      setNote(message(err));
      return;
    }
    await addFiles(found);
  }

  // The reason travels, like every other failure here: a bare "Copy failed" leaves a reader with no
  // way to tell a clipboard the document does not have permission for from one the browser blocked
  // because the click was not trusted.
  function copyRef(key: string) {
    try {
      Promise.resolve(navigator.clipboard.writeText(key))
        .then(() => setNote(`Copied ${key}`))
        .catch((err) => setNote(`${key} could not be copied: ${message(err)}`));
    } catch (err) {
      setNote(`${key} could not be copied: ${message(err)}`);
    }
  }

  async function one(key: string) {
    try {
      setNote(await download(assets, key));
    } catch (err) {
      setNote(message(err));
    }
  }

  // Sequentially, under each file's own name — the browser download pattern
  // src/mdh/downloadCollection.ts establishes, rather than a zip dependency. It follows the
  // filter: a reader who has narrowed the list to three files and clicks the button beside the
  // filter box means those three.
  async function all() {
    // The REASONS, not just the count. This is the action D6 makes mandatory and there is no other
    // channel for it — no log row, no per-file note — so "3 of 3 could not be downloaded" was the
    // whole report of three expired-token refusals. Capped like every other failure list here, and
    // deduplicated because a batch usually fails for one reason repeated.
    let failed = 0;
    const reasons: string[] = [];
    for (let i = 0; i < shown.length; i += 1) {
      setNote(`Downloading ${i + 1} of ${shown.length}…`);
      let why: string | null = null;
      try {
        why = await download(assets, shown[i].key);
      } catch (err) {
        why = message(err);
      }
      if (!why) continue;
      failed += 1;
      // DISTINCT reasons: a whole batch usually fails for one reason repeated, and the note is one
      // line. The count is per FILE, the reasons are per cause.
      if (!reasons.includes(why)) reasons.push(why);
    }
    setNote(
      failed
        ? `${failed} of ${shown.length} could not be downloaded · ${reasonList(reasons)}`
        : null,
    );
  }

  async function remove(key: string) {
    setConfirming(null);
    try {
      await assets.remove(key);
    } catch (err) {
      setNote(message(err));
    }
  }

  return (
    <div
      class={'fabry-arch-asset' + (dragging ? ' dragging' : '')}
      onDragEnter={handlers.dragenter}
      onDragOver={handlers.dragover}
      onDragLeave={handlers.dragleave}
      onDrop={handlers.drop}
    >
      <div class="fabry-arch-asset-hd">
        <span class="fabry-arch-asset-count">
          {rows.length} file{rows.length === 1 ? '' : 's'}
          {' · '}
          {formatBytes(total)}
        </span>
        <span class="fabry-arch-asset-sp" />
        <button
          type="button"
          class="fabry-arch-asset-btn"
          data-act="add"
          disabled={busy || blocked}
          title={blocked ? BLOCKED : undefined}
          onClick={() => fileInput.current && fileInput.current.click()}
        >
          {'+ Add files'}
        </button>
        {folderPicker ? (
          <button
            type="button"
            class="fabry-arch-asset-btn"
            data-act="add-folder"
            disabled={busy || blocked}
            title={blocked ? BLOCKED : 'Bulk import a folder — a one-time copy, not a sync'}
            onClick={addFolder}
          >
            {'⊞ Folder'}
          </button>
        ) : null}
        <button
          type="button"
          class="fabry-arch-asset-btn"
          data-act="download-all"
          disabled={busy || !shown.length}
          title={
            'One browser download per file, so the browser may ask permission after the first. ' +
            'Downloading is the only way an asset leaves this organization.'
          }
          onClick={all}
        >
          {q ? `⤓ Download ${shown.length}` : '⤓ Download all'}
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e: any) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <input
        class="fabry-arch-asset-filter"
        type="search"
        placeholder="Filter by name"
        value={filter}
        onInput={(e: any) => setFilter(e.target.value)}
      />

      {indexError ? (
        <p class="fabry-arch-asset-error">
          {indexError}
          <button
            type="button"
            class="fabry-arch-asset-btn"
            data-act="retry"
            // A read is queued on the store's write chain, so one issued mid-batch waits behind
            // every upload in it — for a 30-file batch, minutes of a button that does nothing
            // visible.
            disabled={busy}
            title={busy ? 'Waiting for the uploads already running' : undefined}
            onClick={() => {
              void assets.load();
            }}
          >
            {'Retry'}
          </button>
        </p>
      ) : null}
      {note ? (
        <p class="fabry-arch-asset-note">
          {note}
          <button
            type="button"
            class="fabry-arch-asset-x"
            aria-label="Dismiss"
            onClick={() => setNote(null)}
          >
            {'×'}
          </button>
        </p>
      ) : null}

      {log.rows.length || tail ? (
        <div class="fabry-arch-asset-log">
          {tail ? <div class="fabry-arch-asset-log-more">{tail}</div> : null}
          {log.rows.map((e) => (
            <div key={e.id} class={'fabry-arch-asset-log-row state-' + e.state}>
              <span class="fabry-arch-asset-name">{e.name}</span>
              <span class={'fabry-arch-asset-pill ' + e.state}>{LOG_LABEL[e.state]}</span>
              {e.detail ? <span class="fabry-arch-asset-meta">{e.detail}</span> : null}
            </div>
          ))}
          <button
            type="button"
            class="fabry-arch-asset-x"
            aria-label="Clear"
            onClick={() => setLog(EMPTY_LOG)}
          >
            {'×'}
          </button>
        </div>
      ) : null}

      {SECTIONS.map(([kind, label]) =>
        groups[kind].length ? (
          <div key={kind} class={'fabry-arch-asset-group ' + kind}>
            <div class="fabry-arch-asset-group-t">{label}</div>
            {groups[kind].map((r) => (
              <div key={r.key} class="fabry-arch-asset-row" data-asset-key={r.key}>
                <span class="fabry-arch-asset-ext">{extChip(r.name)}</span>
                <span class="fabry-arch-asset-name" title={r.key}>
                  {r.name}
                </span>
                <span class="fabry-arch-asset-meta">
                  {formatBytes(r.size)}
                  {' · '}
                  {(refsByKey[r.key] || []).length} ref
                  {(refsByKey[r.key] || []).length === 1 ? '' : 's'}
                </span>
                {kind === 'unused' ? (
                  <span class="fabry-arch-asset-pill unused">unused</span>
                ) : null}
                {kind === 'elsewhere' ? (
                  <span class="fabry-arch-asset-in">{names(r.key)}</span>
                ) : null}
                <span class="fabry-arch-asset-acts">
                  <button
                    type="button"
                    class="fabry-arch-asset-act"
                    data-act="copy"
                    title={'Copy the reference — ' + r.key}
                    onClick={() => copyRef(r.key)}
                  >
                    {'⧉'}
                  </button>
                  <button
                    type="button"
                    class="fabry-arch-asset-act"
                    data-act="download"
                    title="Download"
                    onClick={() => one(r.key)}
                  >
                    {'⤓'}
                  </button>
                  <button
                    type="button"
                    class="fabry-arch-asset-act"
                    data-act="delete"
                    title="Delete"
                    onClick={() => setConfirming(confirming === r.key ? null : r.key)}
                  >
                    {'✕'}
                  </button>
                </span>
                {confirming === r.key ? (
                  // Informed, not blocked (§5.5): what still points at this file is named, and
                  // then the delete is allowed anyway.
                  <div class="fabry-arch-asset-confirm">
                    <span class="fabry-arch-asset-confirm-t">{confirmText(r.key)}</span>
                    <button
                      type="button"
                      class="fabry-arch-asset-btn danger"
                      data-act="delete-confirm"
                      onClick={() => remove(r.key)}
                    >
                      {'Delete'}
                    </button>
                    <button
                      type="button"
                      class="fabry-arch-asset-btn"
                      data-act="delete-cancel"
                      onClick={() => setConfirming(null)}
                    >
                      {'Cancel'}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null,
      )}

      {!rows.length && !indexError ? (
        <p class="fabry-arch-asset-empty">
          {'No files yet. Drop them here, or use Add files — they are stored in this organization.'}
        </p>
      ) : null}
      {rows.length > 0 && !shown.length ? (
        <p class="fabry-arch-asset-empty">{`Nothing matches “${filter.trim()}”.`}</p>
      ) : null}
    </div>
  );
}
