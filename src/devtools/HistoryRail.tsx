// src/devtools/HistoryRail.tsx
// The version list beside the editor (spec §5), with its own paged query.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChangelogEntry, GetJson } from '../changelog/api.js';
import { listEntries, resolveUsers } from '../changelog/api.js';
import { relativeAgo } from '../changelog/feed.js';
import { modifierLabel, versionPageUrl } from '../changelog/names.js';
import type { HistoryRef } from './history.js';

const VISIBLE = 20;

export default function HistoryRail({
  historyRef,
  get,
  domain,
  users,
  selectedId,
  comparedId = null,
  firstPage,
  onSelect,
}: {
  historyRef: HistoryRef;
  get: GetJson;
  /** The inspected org's origin, for the selected version's link to Rossum's own page. */
  domain: string;
  users: Map<number, string>;
  selectedId: number | null;
  /** The version the selected one is diffed against, labelled so both ends are visible. */
  comparedId?: number | null;
  /** Page 1 as the history store already read it (same query), so opening the rail does
   *  not fetch it again; `total` says whether a page 2 exists. */
  firstPage?: { entries: ChangelogEntry[]; total: number };
  onSelect: (e: ChangelogEntry | null) => void;
}) {
  const firstNext = (p: { entries: ChangelogEntry[]; total: number }) =>
    p.total > p.entries.length ? 2 : null;
  // Seeded from the store's page on the first paint, so the rail never opens empty.
  const [rows, setRows] = useState<ChangelogEntry[]>(firstPage ? firstPage.entries : []);
  const [nextPage, setNextPage] = useState<number | null>(firstPage ? firstNext(firstPage) : null);
  const [failed, setFailed] = useState(false);
  // Names for rows past the first page, which the history store did not resolve.
  const [moreUsers, setMoreUsers] = useState<Map<number, string>>(new Map());
  // `rows` buffers every loaded version (a page is 100); only the first `shown` are rendered.
  const [shown, setShown] = useState(VISIBLE);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const filters = { objectTypes: [historyRef.type], objectIds: [historyRef.id] };

  // Switching to another object bumps the generation, so a load that started before it can
  // neither append its rows nor clear the newer load's in-flight flag.
  async function load(from: number, append: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    const gen = generation.current;
    try {
      const page = await listEntries(get, filters, from);
      if (gen !== generation.current) return;
      setRows((prev) => (append ? [...prev, ...page.entries] : page.entries));
      setNextPage(page.hasMore ? from + 1 : null);
      setFailed(false);
      const unknown = page.entries
        .map((e) => e.modifier_id)
        .filter((m): m is number => m != null && !users.has(m));
      if (unknown.length) {
        resolveUsers(get, unknown)
          .then((m) => setMoreUsers((prev) => new Map([...prev, ...m])))
          .catch(() => {}); // names are an upgrade; rows show "User <id>"
      }
    } catch {
      if (gen === generation.current) setFailed(true);
    } finally {
      if (gen === generation.current) inFlight.current = false;
    }
  }

  // A seeded rail already holds the right state on its first paint; resetting it here would
  // only race a Load more clicked before this effect ran.
  const seeded = useRef(!!firstPage);
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    generation.current += 1;
    inFlight.current = false;
    setRows([]);
    setNextPage(null);
    setShown(VISIBLE);
    if (firstPage) {
      setRows(firstPage.entries);
      setNextPage(firstNext(firstPage));
    } else {
      load(1, false);
    }
  }, [historyRef.key]);

  const names = moreUsers.size ? new Map([...users, ...moreUsers]) : users;
  const hasHidden = rows.length > shown;
  const loadMore = () => {
    if (hasHidden) setShown(shown + VISIBLE);
    else if (nextPage != null) {
      setShown(shown + VISIBLE);
      load(nextPage, true);
    }
  };

  return (
    <aside class="rawjson-rail">
      <button
        class={`rawjson-hist-row${selectedId == null ? ' selected' : ''}`}
        onClick={() => onSelect(null)}
      >
        <b>Live</b>
        <span class="rawjson-hist-meta">editable</span>
      </button>
      {rows.slice(0, shown).map((e) => (
        // A link cannot sit inside a button, so the row's button and the selected version's
        // link to Rossum's own page are siblings.
        <div class="rawjson-hist-item" key={e.version_id}>
          <button
            class={`rawjson-hist-row${selectedId === e.version_id ? ' selected' : ''}`}
            onClick={() => onSelect(e)}
          >
            <span>
              {relativeAgo(e.version_created_at)} · {modifierLabel(e.modifier_id, names)}
              {e.version_id === comparedId ? <span class="rawjson-hist-tag">compared</span> : null}
            </span>
            <span class="rawjson-hist-meta">
              {e.version_event === 'update' ? e.changed_fields.join(', ') : e.version_event}
            </span>
          </button>
          {selectedId === e.version_id ? (
            <a
              class="rawjson-hist-diff"
              href={versionPageUrl(domain, e)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this version in Rossum's Configuration Changelog"
            >
              {'Diff ↗'}
            </a>
          ) : null}
        </div>
      ))}
      {failed ? <div class="rawjson-hist-meta">Could not load versions.</div> : null}
      {hasHidden || nextPage != null ? (
        <button class="rawjson-hist-more" onClick={loadMore}>
          Load more
        </button>
      ) : null}
    </aside>
  );
}
